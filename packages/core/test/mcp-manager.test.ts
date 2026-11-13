import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPaths } from '../src/paths.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import { SecretStore, type KeyCrypto } from '../src/secrets/store.ts';
import type { KernelEvent } from '../src/events.ts';
import type { McpServerConfig } from '../src/mcp/config.ts';
import { McpManager, type McpServerState } from '../src/mcp/manager.ts';
import { AbortedError } from '../src/model/types.ts';

const ECHO = fileURLToPath(new URL('./fixtures/mcp/echo-server.mjs', import.meta.url));
const HANG = fileURLToPath(new URL('./fixtures/mcp/hang-server.mjs', import.meta.url));

function fakeCrypto(): KeyCrypto {
  return {
    backend: () => 'os',
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decrypt: (buf) => Buffer.from(buf.toString('utf8').slice(4), 'base64').toString('utf8'),
  };
}

function stdioConfig(
  id: string,
  name: string,
  opts: { file?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): McpServerConfig {
  return {
    id,
    name,
    shortName: id,
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [opts.file ?? ECHO],
      cwd: null,
      env: Object.fromEntries(
        Object.entries(opts.env ?? {}).map(([key, value]) => [key, { secret: false as const, value }]),
      ),
    },
    timeoutMs: opts.timeoutMs ?? 20_000,
    origin: { kind: 'user' },
  };
}

interface Harness {
  root: string;
  manager: McpManager;
  events: KernelEvent[];
  close(): Promise<void>;
}

async function harness(
  servers: McpServerConfig[],
  opts: {
    connectTimeoutMs?: number;
    restartDelayMs?: number;
    env?: NodeJS.ProcessEnv;
    transportFactory?: (server: McpServerConfig) => import('@modelcontextprotocol/client').Transport;
  } = {},
): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-mcp-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.root, { recursive: true });
  const secretStore = new SecretStore(paths.secrets, fakeCrypto(), new SecretSet());
  await secretStore.load();
  const events: KernelEvent[] = [];
  const manager = new McpManager({
    loadServers: async () => servers,
    enabledServerIds: async () => new Set(servers.map((s) => s.id)),
    secretStore,
    emit: (e) => events.push(e),
    home: root,
    connectTimeoutMs: opts.connectTimeoutMs ?? 30_000,
    restartDelayMs: opts.restartDelayMs ?? 50,
    maxRestarts: 3,
    env: opts.env ?? process.env,
    ...(opts.transportFactory !== undefined ? { transportFactory: opts.transportFactory } : {}),
  });
  return { root, manager, events, close: () => manager.stop() };
}

async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function stateOf(h: Harness, id: string): McpServerState {
  const state = h.manager.states().find((s) => s.id === id);
  if (state === undefined) throw new Error(`没有状态：${id}`);
  return state;
}

async function waitStatus(h: Harness, id: string, status: string): Promise<void> {
  await waitFor(() => stateOf(h, id).status === status);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('连旧版与新版：两个 server 都 connected，并缓存工具', async () => {
  const h = await harness([
    stdioConfig('old', 'old', { env: { MCP_SERVER_NAME: 'legacy' } }),
    stdioConfig('new', 'new', { env: { MCP_SERVER_NAME: 'modern' } }),
  ]);
  try {
    await h.manager.start();
    await waitStatus(h, 'old', 'connected');
    await waitStatus(h, 'new', 'connected');
    assert.ok(stateOf(h, 'old').tools.some((t) => t.name === 'echo'));
    assert.ok(stateOf(h, 'new').tools.some((t) => t.name === 'echo'));
    assert.ok(h.events.some((e) => e.type === 'mcp_status' && e.status === 'connected'));
  } finally {
    await h.close();
  }
});

test('不响应：连接超时后 failed，另一个 server 不受影响', async () => {
  const hanging = {
    start: () => new Promise<void>(() => undefined),
    send: async () => undefined,
    close: async () => undefined,
  };
  const h = await harness([stdioConfig('hang', 'hang', { file: HANG })], {
    connectTimeoutMs: 400,
    transportFactory: () => hanging as never,
  });
  try {
    await h.manager.start();
    await waitStatus(h, 'hang', 'failed');
    assert.equal(stateOf(h, 'hang').error, '连接超时');
  } finally {
    await h.close();
  }
});

test('崩溃重启：连续失败后停在 failed，手动 connect 后恢复', async () => {
  const h = await harness([stdioConfig('crash', 'crash')], { restartDelayMs: 20 });
  const signal = new AbortController().signal;
  try {
    await h.manager.start();
    await waitStatus(h, 'crash', 'connected');
    for (let i = 0; i < 4; i += 1) {
      await waitStatus(h, 'crash', 'connected');
      await h.manager.call('crash', 'crash', {}, signal).catch(() => undefined);
      await waitFor(() => stateOf(h, 'crash').status !== 'connected');
    }
    await waitStatus(h, 'crash', 'failed');
    assert.match(stateOf(h, 'crash').error ?? '', /已重启 3 次仍失败/);

    await h.manager.connect('crash');
    await waitStatus(h, 'crash', 'connected');
  } finally {
    await h.close();
  }
});

test('调用超时：返回错误结果，server 仍 connected', async () => {
  const h = await harness([stdioConfig('slow', 'slow', { timeoutMs: 500 })]);
  try {
    await h.manager.start();
    await waitStatus(h, 'slow', 'connected');
    const result = await h.manager.call('slow', 'slow', {}, new AbortController().signal);
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.type === 'text' ? result.content[0]!.text : '', /MCP 调用失败/);
    assert.equal(stateOf(h, 'slow').status, 'connected');
  } finally {
    await h.close();
  }
});

test('取消：中止 signal 抛 AbortedError，之后还能正常调用', async () => {
  const h = await harness([stdioConfig('slow', 'slow', { timeoutMs: 10_000 })]);
  try {
    await h.manager.start();
    await waitStatus(h, 'slow', 'connected');
    const controller = new AbortController();
    const promise = h.manager.call('slow', 'slow', {}, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(promise, (err: unknown) => err instanceof AbortedError);
    const echo = await h.manager.call('slow', 'echo', { text: 'ok' }, new AbortController().signal);
    assert.equal(echo.isError, false);
    assert.equal(echo.content[0]!.type === 'text' ? echo.content[0]!.text : '', 'echo:ok');
  } finally {
    await h.close();
  }
});

test('环境隔离：不继承内核进程的其余变量，只含最小系统变量与配置声明', async () => {
  const previous = process.env['MINIBOT_SECRET_X'];
  process.env['MINIBOT_SECRET_X'] = 'should-not-leak';
  const h = await harness([stdioConfig('env', 'env', { env: { CUSTOM_VAR: 'yes' } })]);
  try {
    await h.manager.start();
    await waitStatus(h, 'env', 'connected');
    const result = await h.manager.call('env', 'env', {}, new AbortController().signal);
    const text = result.content[0]!.type === 'text' ? result.content[0]!.text : '';
    const env = JSON.parse(text) as Record<string, string>;
    assert.equal(env['MINIBOT_SECRET_X'], undefined);
    assert.equal(env['CUSTOM_VAR'], 'yes');
    assert.ok(typeof env['PATH'] === 'string');
  } finally {
    await h.close();
    if (previous === undefined) delete process.env['MINIBOT_SECRET_X'];
    else process.env['MINIBOT_SECRET_X'] = previous;
  }
});

test('停止清理进程树：stop 后 stdio server 起的子进程也退出', async () => {
  const h = await harness([]);
  const pidFile = path.join(h.root, 'child.pid');
  const config = stdioConfig('child', 'child', { env: { MCP_TEST_MODE: 'child', CHILD_PID_FILE: pidFile } });
  const manager = new McpManager({
    loadServers: async () => [config],
    enabledServerIds: async () => new Set(['child']),
    secretStore: new SecretStore(dataPaths(h.root).secrets, fakeCrypto(), new SecretSet()),
    emit: () => {},
    home: h.root,
    connectTimeoutMs: 10_000,
  });
  await manager.start();
  await waitFor(() => manager.states()[0]?.status === 'connected');
  await waitFor(() => existsSync(pidFile));
  const childPid = Number(await fs.readFile(pidFile, 'utf8'));
  assert.ok(childPid > 0);
  await manager.stop();
  await waitFor(() => !isAlive(childPid));
});
