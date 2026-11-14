import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPaths } from '../src/paths.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import { SecretStore } from '../src/secrets/store.ts';
import { McpManager } from '../src/mcp/manager.ts';
import { startOAuthCallback } from '../src/mcp/oauth.ts';
import { PluginService } from '../src/plugins/registry.ts';
import { startServer } from '../src/server/server.ts';
import type { McpServerConfig, McpServerDraft } from '../src/mcp/config.ts';
import { fakeCrypto, kernelHarness } from './kernel-harness.ts';

const STDERR_SERVER = fileURLToPath(new URL('./fixtures/mcp/stderr-server.mjs', import.meta.url));

function rawGet(port: number, reqPath: string, host = `127.0.0.1:${port}`): Promise<string> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, headers: { host }, timeout: 1500 }, (res) => {
      res.resume();
      resolve(`status ${res.statusCode}`);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve('timeout');
    });
    req.on('error', (e) => resolve(`error ${e.message}`));
    req.end();
  });
}

async function mcpHarness(servers: McpServerConfig[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-b1-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.root, { recursive: true });
  const secretStore = new SecretStore(paths.secrets, fakeCrypto(), new SecretSet());
  await secretStore.load();
  const manager = new McpManager({
    loadServers: async () => servers,
    enabledServerIds: async () => new Set(servers.map((s) => s.id)),
    secretStore,
    emit: () => {},
    home: root,
    connectTimeoutMs: 8_000,
  });
  return { root, manager };
}

test('MCP stdio：server 往 stderr 写大量日志不会被阻塞', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-b1-'));
  const marker = path.join(root, 'stderr-done');
  const { manager } = await mcpHarness([
    {
      id: 'e',
      name: 'e',
      shortName: 'e',
      transport: { type: 'stdio', command: process.execPath, args: [STDERR_SERVER], cwd: null, env: { STDERR_DONE_FILE: { secret: false, value: marker } } },
      timeoutMs: 10_000,
      origin: { kind: 'user' },
    },
  ]);
  try {
    await manager.connect('e');
    assert.equal(manager.states().find((s) => s.id === 'e')?.status, 'connected');
    await fs.access(marker);
  } finally {
    await manager.stop();
  }
});

test('MCP http：地址非法时状态变 failed，不会停在 connecting', async () => {
  const { manager } = await mcpHarness([
    {
      id: 's1',
      name: 'x',
      shortName: 'x',
      transport: { type: 'http', url: 'example.com/mcp', headers: {}, auth: 'none' },
      timeoutMs: 1000,
      origin: { kind: 'user' },
    },
  ]);
  try {
    await manager.connect('s1').catch(() => undefined);
    const state = manager.states().find((s) => s.id === 's1');
    assert.equal(state?.status, 'failed');
    assert.ok(state?.error);
  } finally {
    await manager.stop();
  }
});

test('kernel.addMcpServer / updateMcpServer 校验 transport 与 http 地址', async () => {
  const h = await kernelHarness();
  try {
    const base = { name: 'a', shortName: '', timeoutMs: 1000 };
    const bad: unknown[] = [
      { ...base },
      { ...base, transport: { type: 'ftp' } },
      { ...base, transport: { type: 'http', url: 'example.com/mcp', headers: {}, auth: 'none' } },
      { ...base, transport: { type: 'http', url: 'file:///etc/passwd', headers: {}, auth: 'none' } },
      { ...base, transport: { type: 'stdio', command: '', args: [], cwd: null, env: {} } },
    ];
    for (const draft of bad) {
      await assert.rejects(h.kernel.addMcpServer(draft as McpServerDraft), { code: 'invalid' });
    }
    const ok = await h.kernel.addMcpServer({
      ...base,
      transport: { type: 'http', url: 'https://example.com/mcp', headers: {}, auth: 'none' },
    });
    await assert.rejects(
      h.kernel.updateMcpServer(ok.id, { ...base, transport: { type: 'http', url: 'nope', headers: {}, auth: 'none' } }),
      { code: 'invalid' },
    );
    assert.equal((await h.kernel.mcpServerList()).length, 1);
  } finally {
    await h.close();
  }
});

test('HTTP 服务：请求路径 // 得到 400，不产生未处理 rejection', async () => {
  let unhandled = 0;
  const onUnhandled = () => {
    unhandled += 1;
  };
  process.on('unhandledRejection', onUnhandled);
  const server = await startServer({ on: () => () => {} } as never, { staticDir: os.tmpdir() });
  try {
    assert.equal(await rawGet(server.port, '//'), 'status 400');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(unhandled, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await server.close();
  }
});

test('OAuth 回调：请求路径 // 不抛 uncaughtException，返回 400', async () => {
  const cb = await startOAuthCallback();
  const port = Number(new URL(cb.redirectUrl).port);
  const uncaught: Error[] = [];
  const listeners = process.listeners('uncaughtException');
  process.removeAllListeners('uncaughtException');
  const onUncaught = (e: Error) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    assert.equal(await rawGet(port, '//'), 'status 400');
    assert.deepEqual(uncaught, []);
  } finally {
    process.off('uncaughtException', onUncaught);
    for (const l of listeners) process.on('uncaughtException', l);
    await cb.close().catch(() => undefined);
  }
});

test('extensions.json：MCP 增删与插件登记并发读改写不丢更新', async () => {
  const h = await kernelHarness();
  try {
    const svc = (h.kernel as unknown as { pluginService: PluginService }).pluginService;
    const draft = (name: string): McpServerDraft => ({
      name,
      shortName: '',
      timeoutMs: 1000,
      transport: { type: 'http', url: `https://example.com/${name}`, headers: {}, auth: 'none' },
    });
    const names = ['a', 'b', 'c', 'd'];
    await Promise.all([
      ...names.map((n) => h.kernel.addMcpServer(draft(n))),
      svc.addMarket('https://example.com/m1.git'),
      svc.addMarket('https://example.com/m2.git'),
      h.kernel.updateWebSettings({ fetchEnabled: false }),
    ]);
    const list = await h.kernel.mcpServerList();
    assert.deepEqual(list.map((s) => s.name).sort(), names);
    assert.equal((await svc.markets()).length, 2);
    assert.equal((await h.kernel.webSettings()).fetchEnabled, false);
    await Promise.all(list.slice(0, 2).map((s) => h.kernel.deleteMcpServer(s.id)));
    assert.equal((await h.kernel.mcpServerList()).length, 2);
  } finally {
    await h.close();
  }
});

