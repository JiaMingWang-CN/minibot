// 第 2 批代码审查问题（tools / approval / paths / fs / secrets / web / dispatch）的回归测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { dataPaths } from '../src/paths.ts';
import { newBot } from '../src/config/config.ts';
import { openDb } from '../src/db/db.ts';
import { MemoryRevisions } from '../src/memory/revisions.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import { SecretStore, type KeyCrypto } from '../src/secrets/store.ts';
import { ReadTracker } from '../src/tools/read-tracker.ts';
import { ApprovalBroker } from '../src/approval/broker.ts';
import { decide } from '../src/approval/policy.ts';
import { classifyPath, type ClassifyContext } from '../src/tools/path-guard.ts';
import { executeTool, type ToolEnv } from '../src/tools/registry.ts';
import { clipToOutputs, OUTPUT_LIMIT } from '../src/tools/output.ts';
import { readFile } from '../src/tools/files.ts';
import { grepFiles } from '../src/tools/search.ts';
import { ToolCatalog, type ExternalToolProvider } from '../src/tools/catalog.ts';
import { WebToolProvider } from '../src/web/web-tools.ts';
import { SearchToolProvider } from '../src/web/search-tools.ts';
import { isBlockedAddress } from '../src/web/ip-guard.ts';
import type { McpManager, McpServerState, McpCallResult } from '../src/mcp/manager.ts';
import type { WebSettings } from '../src/extensions/store.ts';
import { dispatchApi, type ApiRequest } from '../src/server/dispatch.ts';
import { startServer } from '../src/server/server.ts';
import { Kernel } from '../src/kernel.ts';
import { kernelHarness, fakeCrypto, textModel } from './kernel-harness.ts';

const isWin = process.platform === 'win32';

async function tmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `minibot-b2-${prefix}-`));
}

function req(method: string, url: string, body?: unknown): ApiRequest {
  return { method, url: new URL(url, 'http://x'), readBody: async () => body };
}

async function toolEnv(mode: 'ask' | 'edits' | 'auto') {
  const root = await tmp('env');
  const paths = dataPaths(root);
  const bot = newBot('b1');
  bot.approvalMode = mode;
  await fs.mkdir(paths.defaultWorkspace(bot.id), { recursive: true });
  await fs.mkdir(paths.memoryDir(bot.id), { recursive: true });
  const db = openDb(paths.db);
  const broker = new ApprovalBroker(() => {});
  const env: ToolEnv = {
    bot,
    threadId: 't1',
    workspace: paths.defaultWorkspace(bot.id),
    paths,
    home: path.join(root, 'home'),
    tracker: new ReadTracker(),
    secrets: new SecretSet(),
    revisions: new MemoryRevisions(db, paths),
    broker,
    signal: new AbortController().signal,
  };
  return { env, broker, paths, db };
}

// ---- outputs 目录 ----

function classifyCtx(root: string): ClassifyContext {
  const paths = dataPaths(root);
  return { paths, botId: 'b1', workspace: paths.defaultWorkspace('b1'), home: path.join(root, 'home') };
}

test('outputs 目录：分类为 outputs，数据目录里其他文件仍是 sensitive', () => {
  const ctx = classifyCtx('/data/mb');
  assert.equal(classifyPath('/data/mb/outputs/output-1.txt', ctx), 'outputs');
  assert.equal(classifyPath('/data/mb/outputs', ctx), 'outputs');
  assert.equal(classifyPath('/data/mb/outputs-evil/x', ctx), 'sensitive');
  assert.equal(classifyPath('/data/mb/devices.json', ctx), 'sensitive');
  assert.equal(classifyPath('/data/mb/minibot.db', ctx), 'sensitive');
  assert.equal(classifyPath('/data/mb/secrets.bin', ctx), 'sensitive');
});

test('outputs 目录：只读工具免审批，写入仍要审批', () => {
  for (const tool of ['read_file', 'glob', 'grep'] as const) {
    assert.equal(decide('ask', tool, ['outputs']), 'allow', tool);
  }
  for (const mode of ['ask', 'edits'] as const) {
    assert.equal(decide(mode, 'write_file', ['outputs']), 'ask', `${mode} write`);
    assert.equal(decide(mode, 'edit_file', ['outputs']), 'ask', `${mode} edit`);
  }
  assert.equal(decide('ask', 'read_file', ['sensitive']), 'ask');
});

test('clipToOutputs 写出的完整输出，模型用 read_file 去读不弹审批；读 devices.json 仍弹', async () => {
  const { env, broker, paths, db } = await toolEnv('ask');
  try {
    const clipped = await clipToOutputs('x'.repeat(OUTPUT_LIMIT + 100), paths.outputs);
    const fullPath = /完整输出见 (.+?)\]/.exec(clipped)![1]!;
    const ok = await executeTool({ type: 'tool_use', id: 'a', name: 'read_file', input: { path: fullPath } }, env);
    assert.equal(ok.status, 'ok');
    assert.equal(broker.pending().length, 0);

    await fs.writeFile(paths.devicesJson, '[]');
    const pending = executeTool({ type: 'tool_use', id: 'b', name: 'read_file', input: { path: paths.devicesJson } }, env);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(broker.pending().length, 1);
    broker.respond(broker.pending()[0]!.id, 'denied');
    await pending;

    const write = executeTool({ type: 'tool_use', id: 'c', name: 'write_file', input: { path: fullPath, content: 'y' } }, env);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(broker.pending().length, 1);
    broker.respond(broker.pending()[0]!.id, 'denied');
    await write;
  } finally {
    db.close();
  }
});

test('内置工具审批卡片的 summary 也脱敏', async () => {
  const { env, broker, db } = await toolEnv('ask');
  try {
    env.secrets.add('sk-very-secret-key');
    const pending = executeTool(
      { type: 'tool_use', id: 'a', name: 'run_command', input: { command: 'echo sk-very-secret-key' } },
      env,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [request] = broker.pending();
    assert.ok(request !== undefined);
    assert.ok(!request.summary.includes('sk-very-secret-key'), request.summary);
    broker.respond(request.id, 'denied');
    await pending;
  } finally {
    db.close();
  }
});

// ---- read_file / grep ----

test('read_file 拒绝非普通文件（FIFO 不会挂住）', { skip: isWin }, async () => {
  const dir = await tmp('fifo');
  const fifo = path.join(dir, 'pipe');
  execFileSync('mkfifo', [fifo]);
  const { env, db } = await toolEnv('ask');
  try {
    const result = await Promise.race([
      readFile({ tracker: env.tracker, secrets: env.secrets, revisions: env.revisions, paths: env.paths, actor: 'b1' }, fifo, {}),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1500)),
    ]);
    assert.notEqual(result, 'hung');
    assert.equal((result as { isError: boolean }).isError, true);
  } finally {
    db.close();
  }
});

test('grep 的 path 指向文件：只搜这个文件，不报 spawn 错误', async () => {
  const dir = await tmp('grepfile');
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello world\n');
  await fs.writeFile(path.join(dir, 'b.txt'), 'hello other\n');
  const result = await grepFiles(path.join(dir, 'a.txt'), { pattern: 'hello' }, new AbortController().signal);
  assert.equal(result.isError, false, result.content);
  assert.ok(result.content.includes('a.txt'));
  assert.ok(!result.content.includes('b.txt'));
});

// ---- catalog / search-tools / web-tools ----

test('外部工具不能占用 load_skill 这个直通工具名', async () => {
  const provider: ExternalToolProvider = {
    toolsFor: async () => [
      {
        spec: { name: 'load_skill', description: 'x', parameters: { type: 'object', properties: {} } },
        source: { kind: 'web' },
        summarize: () => 's',
        run: async () => ({ content: 'ext', isError: false }),
      },
    ],
  };
  const catalog = new ToolCatalog();
  catalog.register(provider);
  const set = await catalog.snapshot(newBot('b1'), [{ name: 's', description: 'd' } as never]);
  assert.equal(set.specs.filter((s) => s.name === 'load_skill').length, 1);
  assert.equal(set.external('load_skill'), undefined);
});

function fakeManager(states: McpServerState[]): McpManager {
  return {
    states: () => states,
    call: async (): Promise<McpCallResult> => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  } as unknown as McpManager;
}

test('fetchEnabled 关闭时搜索引擎的 fetch 类工具也不提供，搜索工具保留', async () => {
  const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
  const manager = fakeManager([
    { id: 'plugin:deepseek:deepseek', status: 'connected', error: null, tools: [tool('deepseek_search'), tool('deepseek_fetch')] },
  ]);
  const settings: WebSettings = { fetchEnabled: false, searchEngine: 'deepseek' };
  const provider = new SearchToolProvider({ manager, loadSettings: () => settings, isPluginEnabled: () => true });
  const bot = newBot('b1');
  bot.extensions.web = true;
  assert.deepEqual((await provider.toolsFor(bot)).map((t) => t.spec.name), ['deepseek_search']);
  settings.fetchEnabled = true;
  assert.deepEqual((await provider.toolsFor(bot)).map((t) => t.spec.name).sort(), ['deepseek_fetch', 'deepseek_search']);
});

test('web_fetch：短 JSON / 短纯文本不被当作动态页面', async () => {
  const provider = new WebToolProvider({
    loadSettings: () => ({ fetchEnabled: true, searchEngine: 'none' }),
    fetch: async () => ({
      finalUrl: 'https://x/a.json',
      status: 200,
      contentType: 'application/json',
      charset: null,
      body: Buffer.from('{"ok":true}'),
    }),
  });
  const bot = newBot('b1');
  bot.extensions.web = true;
  const [tool] = await provider.toolsFor(bot);
  const out = await tool!.run({ url: 'https://x/a.json' }, { bot, threadId: 't', signal: new AbortController().signal, supportsImages: false });
  assert.equal(out.isError, false, out.content);
  assert.ok(out.content.includes('"ok": true'));
});

// ---- secrets/store ----

function strictCrypto(): KeyCrypto {
  return fakeCrypto();
}

test('SecretStore：secrets.bin 内容不是对象时按无法读取处理，覆盖前先备份', async () => {
  const dir = await tmp('sec');
  const file = path.join(dir, 'secrets.bin');
  const crypto = strictCrypto();
  await fs.writeFile(file, crypto.encrypt('[1,2]'));
  const store = new SecretStore(file, crypto, new SecretSet());
  await store.load();
  assert.equal(store.isUnreadable(), true);
  await store.set('p1', 'sk-abcdefgh');
  const names = await fs.readdir(dir);
  assert.ok(names.some((n) => n.startsWith('secrets.bin.unreadable-')), names.join(','));
});

test('SecretStore：读文件失败（非 ENOENT）后 set 不会覆盖原文件', async () => {
  const dir = await tmp('sec2');
  const file = path.join(dir, 'secrets.bin');
  await fs.mkdir(file); // 读目录 → EISDIR
  const store = new SecretStore(file, strictCrypto(), new SecretSet());
  await assert.rejects(store.load());
  await assert.rejects(store.set('p1', 'sk-abcdefgh'));
  assert.ok((await fs.stat(file)).isDirectory());
});

// ---- ip-guard ----

test('ip-guard：站点本地 / Teredo / 6to4 中继 地址被拒', () => {
  assert.equal(isBlockedAddress('fec0::1'), true);
  assert.equal(isBlockedAddress('2001:0:4136:e378:8000:63bf:3fff:fdd2'), true);
  assert.equal(isBlockedAddress('192.88.99.1'), true);
  assert.equal(isBlockedAddress('93.184.216.34'), false);
  assert.equal(isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946'), false);
});

// ---- dispatch ----

test('dispatch：路径里的畸形 % 编码返回 400 而不是 500', async () => {
  const h = await kernelHarness();
  try {
    for (const url of ['/api/threads/%E0%A4%A', '/api/bots/%zz/skills', '/api/attachments/%']) {
      const res = await dispatchApi(h.kernel, req('GET', url));
      assert.equal(res.status, 400, url);
    }
    const bad = await dispatchApi(h.kernel, req('PUT', '/api/settings', { consolidationModel: [] }));
    assert.equal(bad.status, 400);
  } finally {
    await h.close();
  }
});

// ---- kernel：图片 mediaType / 权限 ----

test('sendMessage：mediaType 为原型键（toString 等）被拒绝', async () => {
  const h = await kernelHarness();
  try {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    for (const mediaType of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      assert.throws(
        () => h.kernel.sendMessage(h.threadId, 'x', [{ mediaType: mediaType as never, data: png }]),
        /图片格式/,
        mediaType,
      );
    }
  } finally {
    await h.close();
  }
});

test('数据目录 0700，secrets.bin 0600（POSIX）', { skip: isWin }, async () => {
  const root = await tmp('perm');
  await fs.chmod(root, 0o755);
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: textModel() });
  try {
    const provider = await kernel.addProvider({
      name: 'P',
      format: 'chat_completions',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'sk-perm-secret-123',
    });
    assert.ok(provider.id.length > 0);
    assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(root, 'secrets.bin'))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(root, 'minibot.db'))).mode & 0o777, 0o600);
  } finally {
    await kernel.close();
  }
});

// ---- server：WebSocket 帧上限 ----

test('WS：超大帧被拒（1009），不接受认证前的大消息', async () => {
  const root = await tmp('ws');
  const staticDir = path.join(root, 'static');
  await fs.mkdir(staticDir, { recursive: true });
  await fs.writeFile(path.join(staticDir, 'index.html'), '<title>ok</title>');
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: textModel() });
  const server = await startServer(kernel, { staticDir });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin: server.origin });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    ws.send('x'.repeat(2 * 1024 * 1024));
    assert.equal(await closed, 1009);
  } finally {
    await server.close();
    await kernel.close();
  }
});

