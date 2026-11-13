import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchApi, REMOTE_FORBIDDEN, type ApiRequest } from '../src/server/dispatch.ts';
import { kernelHarness, waitIdle, fakeCrypto } from './kernel-harness.ts';
import { dataPaths } from '../src/paths.ts';
import { newBot, saveBot } from '../src/config/config.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import { SecretStore } from '../src/secrets/store.ts';
import { Kernel } from '../src/kernel.ts';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function req(method: string, path: string, body?: unknown): ApiRequest {
  return {
    method,
    url: new URL(path, 'http://x'),
    readBody: async () => body,
  };
}

test('dispatch 附件', async () => {
  const h = await kernelHarness();
  try {
    h.kernel.sendMessage(h.threadId, '图', [{ mediaType: 'image/png', data: PNG }]);
    await waitIdle(h);
    const messages = h.kernel.listMessages(h.threadId);
    const image = messages[0]!.blocks.find((b) => b.type === 'image') as { id: string };
    const res = await dispatchApi(h.kernel, req('GET', `/api/attachments/${image.id}`));
    assert.equal(res.status, 200);
    assert.ok('bytes' in res);
    assert.equal(res.contentType, 'image/png');
    assert.ok(res.bytes.length > 0);
  } finally {
    await h.close();
  }
});

test('dispatch 错误转换', async () => {
  const h = await kernelHarness();
  try {
    const res = await dispatchApi(h.kernel, req('PATCH', '/api/threads/nope', { title: 'x' }));
    assert.equal(res.status, 404);
    assert.ok('json' in res);
    assert.equal((res.json as { error: { code: string } }).error.code, 'not_found');
  } finally {
    await h.close();
  }
});

test('state 不含 Key', async () => {
  const h = await kernelHarness();
  try {
    const res = await dispatchApi(h.kernel, req('GET', '/api/state'));
    assert.equal(res.status, 200);
    assert.ok('json' in res);
    assert.ok(!JSON.stringify(res.json).includes('sk-harness-secret-123'));
  } finally {
    await h.close();
  }
});

test('REMOTE_FORBIDDEN 形状', () => {
  assert.equal(REMOTE_FORBIDDEN.status, 403);
  assert.ok('json' in REMOTE_FORBIDDEN);
  assert.equal((REMOTE_FORBIDDEN.json as { error: { code: string } }).error.code, 'remote_forbidden');
});

test('PUT 网页抓取：关闭后 GET 返回 false，快照里没有 web_fetch', async () => {
  const h = await kernelHarness();
  try {
    const before = await dispatchApi(h.kernel, req('GET', '/api/extensions/web'));
    assert.equal(before.status, 200);
    assert.deepEqual(before.json, { fetchEnabled: true, searchEngine: 'none' });
    assert.ok((await h.kernel.tools.snapshot(h.bot)).specs.some((s) => s.name === 'web_fetch'));

    const put = await dispatchApi(h.kernel, req('PUT', '/api/extensions/web', { fetchEnabled: false }));
    assert.equal(put.status, 200);
    const after = await dispatchApi(h.kernel, req('GET', '/api/extensions/web'));
    assert.deepEqual(after.json, { fetchEnabled: false, searchEngine: 'none' });
    assert.equal((await h.kernel.tools.snapshot(h.bot)).specs.some((s) => s.name === 'web_fetch'), false);
  } finally {
    await h.close();
  }
});

test('PUT 非法搜索引擎返回 400', async () => {
  const h = await kernelHarness();
  try {
    const res = await dispatchApi(h.kernel, req('PUT', '/api/extensions/web', { searchEngine: 'tavily' }));
    assert.equal(res.status, 400);
    assert.ok('json' in res);
    assert.equal((res.json as { error: { message: string } }).error.message, '搜索引擎不可用');
  } finally {
    await h.close();
  }
});

function mcpDraft(name: string, env: Record<string, { value: string; secret: boolean }> = {}) {
  return {
    name,
    shortName: name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20),
    transport: { type: 'stdio', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: null, env },
    timeoutMs: 60000,
  };
}

test('MCP 添加：默认只给主 bot 启用，GET 不泄露 secret', async () => {
  const h = await kernelHarness();
  try {
    const paths = dataPaths(h.root);
    await saveBot(paths, { ...newBot('other'), name: '副 bot' });
    const res = await dispatchApi(
      h.kernel,
      req('POST', '/api/mcp/servers', mcpDraft('演示 server', { API_KEY: { value: 'sk-mcp-dispatch-123', secret: true } })),
    );
    assert.equal(res.status, 200);
    assert.ok('json' in res);
    const created = res.json as { id: string };

    const state = await h.kernel.state();
    assert.ok(state.bots.find((b) => b.id === h.bot.id)!.extensions.mcpServers.includes(created.id));
    assert.equal(state.bots.find((b) => b.id === 'other')!.extensions.mcpServers.includes(created.id), false);

    const list = await dispatchApi(h.kernel, req('GET', '/api/mcp/servers'));
    assert.equal(list.status, 200);
    assert.ok('json' in list);
    assert.equal(JSON.stringify(list.json).includes('sk-mcp-dispatch-123'), false);
  } finally {
    await h.close();
  }
});

test('MCP 删除：密钥、所有 bot 引用与配置都清理', async () => {
  const h = await kernelHarness();
  try {
    const res = await dispatchApi(
      h.kernel,
      req('POST', '/api/mcp/servers', mcpDraft('待删', { API_KEY: { value: 'sk-delete-me', secret: true } })),
    );
    const created = (res as { json: { id: string } }).json;
    const del = await dispatchApi(h.kernel, req('DELETE', `/api/mcp/servers/${created.id}`));
    assert.equal(del.status, 200);

    const store = new SecretStore(dataPaths(h.root).secrets, fakeCrypto(), new SecretSet());
    await store.load();
    assert.equal(store.get(`mcp:${created.id}:env:API_KEY`), null);
    const state = await h.kernel.state();
    assert.equal(state.bots.some((b) => b.extensions.mcpServers.includes(created.id)), false);
    const list = await dispatchApi(h.kernel, req('GET', '/api/mcp/servers'));
    assert.deepEqual((list as { json: { servers: unknown[] } }).json.servers, []);
  } finally {
    await h.close();
  }
});

test('MCP 没有密钥库时带 secret 添加返回 400', async () => {
  const basicCrypto = {
    backend: () => 'basic_text',
    encrypt: (plain: string) => Buffer.from(plain),
    decrypt: (buf: Buffer) => buf.toString('utf8'),
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-nokeystore-'));
  const kernel = await Kernel.open({ dataRoot: root, crypto: basicCrypto, platform: 'linux' });
  try {
    const provider = await kernel.addProvider({
      name: 'P',
      format: 'chat_completions',
      baseUrl: 'http://x',
      apiKeyEnv: 'MINIBOT_MCP_TEST_KEY',
    });
    await kernel.completeOnboarding({ providerId: provider.id, model: 'm' });
    const res = await dispatchApi(
      kernel,
      req('POST', '/api/mcp/servers', mcpDraft('需要密钥', { API_KEY: { value: 'sk-x', secret: true } })),
    );
    assert.equal(res.status, 400);
    assert.ok('json' in res);
    assert.equal(
      (res.json as { error: { message: string } }).error.message,
      '当前系统没有可用的密钥库，无法保存这个 MCP server 的密钥',
    );
  } finally {
    await kernel.close();
  }
});

test('MCP 从 JSON 解析', async () => {
  const h = await kernelHarness();
  try {
    const res = await dispatchApi(
      h.kernel,
      req('POST', '/api/mcp/parse', { text: '{"mcpServers":{"fs":{"command":"npx"}}}' }),
    );
    assert.equal(res.status, 200);
    assert.ok('json' in res);
    assert.equal((res.json as { servers: unknown[] }).servers.length, 1);
  } finally {
    await h.close();
  }
});
