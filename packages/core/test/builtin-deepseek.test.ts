import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dataPaths } from '../src/paths.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import { SecretStore, type KeyCrypto } from '../src/secrets/store.ts';
import { McpManager, type McpServerState } from '../src/mcp/manager.ts';
import type { McpServerConfig } from '../src/mcp/config.ts';
import { PluginService } from '../src/plugins/registry.ts';

const SERVER_MJS = fileURLToPath(new URL('../../builtin-plugins/deepseek/server.mjs', import.meta.url));
const BUILTIN_DIR = fileURLToPath(new URL('../../builtin-plugins', import.meta.url));

function fakeCrypto(): KeyCrypto {
  return {
    backend: () => 'os',
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decrypt: (buf) => Buffer.from(buf.toString('utf8').slice(4), 'base64').toString('utf8'),
  };
}

function stdioConfig(baseUrl: string, key = 'k'): McpServerConfig {
  return {
    id: 'ds',
    name: 'deepseek',
    shortName: 'ds',
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [SERVER_MJS],
      cwd: null,
      env: {
        DEEPSEEK_API_KEY: { secret: false, value: key },
        DEEPSEEK_BASE_URL: { secret: false, value: baseUrl },
      },
    },
    timeoutMs: 20_000,
    origin: { kind: 'user' },
  };
}

async function managerFor(config: McpServerConfig): Promise<{ manager: McpManager; close(): Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-ds-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.root, { recursive: true });
  const secretStore = new SecretStore(paths.secrets, fakeCrypto(), new SecretSet());
  await secretStore.load();
  const manager = new McpManager({
    loadServers: async () => [config],
    enabledServerIds: async () => new Set([config.id]),
    secretStore,
    emit: () => {},
    home: root,
    connectTimeoutMs: 20_000,
  });
  await manager.start();
  return { manager, close: () => manager.stop() };
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function state(m: McpManager): McpServerState {
  const s = m.states()[0];
  if (s === undefined) throw new Error('没有状态');
  return s;
}

interface Upstream {
  url: string;
  close(): Promise<void>;
  last: () => { body: string; auth: string | undefined; path: string } | null;
}

async function upstream(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Upstream> {
  let last: { body: string; auth: string | undefined; path: string } | null = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      last = { body, auth: req.headers['authorization'] as string | undefined, path: req.url ?? '' };
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    last: () => last,
  };
}

test('DeepSeek 协议：连接成功，工具为 deepseek_search、deepseek_fetch，schema 字段一致', async () => {
  const up = await upstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const h = await managerFor(stdioConfig(up.url));
  try {
    await waitFor(() => state(h.manager).status === 'connected');
    const tools = state(h.manager).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ['deepseek_fetch', 'deepseek_search']);
    const search = tools.find((t) => t.name === 'deepseek_search')!;
    const props = (search.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.ok('query' in props && 'count' in props && 'ori_question' in props && 'localization' in props && 'need_content' in props);
    const fetchSchema = tools.find((t) => t.name === 'deepseek_fetch')!.inputSchema as { properties: Record<string, unknown> };
    assert.ok('url' in fetchSchema.properties);
  } finally {
    await h.close();
    await up.close();
  }
});

test('DeepSeek 原样转发：请求体与参数相同、带 Bearer Key、返回原文', async () => {
  const payload = '{"results":[{"title":"t","url":"https://x"}]}';
  const up = await upstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  });
  const h = await managerFor(stdioConfig(up.url, 'sk-test'));
  try {
    await waitFor(() => state(h.manager).status === 'connected');
    const result = await h.manager.call('ds', 'deepseek_search', { query: 'x', count: 3, need_content: true }, new AbortController().signal);
    assert.equal(result.isError, false);
    assert.equal(result.content[0]!.type === 'text' ? result.content[0]!.text : '', payload);
    const seen = up.last()!;
    assert.deepEqual(JSON.parse(seen.body), { query: 'x', count: 3, need_content: true });
    assert.equal(seen.auth, 'Bearer sk-test');
    assert.equal(seen.path, '/v1/tools/search');
  } finally {
    await h.close();
    await up.close();
  }
});

test('DeepSeek 错误原样：402 返回 isError，含状态码与原文', async () => {
  const errorBody = '{"error":{"message":"quota exceeded","code":"insufficient_quota"}}';
  const up = await upstream((_req, res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(errorBody);
  });
  const h = await managerFor(stdioConfig(up.url));
  try {
    await waitFor(() => state(h.manager).status === 'connected');
    const result = await h.manager.call('ds', 'deepseek_search', { query: 'x' }, new AbortController().signal);
    assert.equal(result.isError, true);
    const text = result.content[0]!.type === 'text' ? result.content[0]!.text : '';
    assert.match(text, /402/);
    assert.ok(text.includes(errorBody));
  } finally {
    await h.close();
    await up.close();
  }
});

class FakeMcp {
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sync(): Promise<void> {}
  states(): McpServerState[] {
    return [];
  }
}

async function pluginService(getKey: () => string | null): Promise<{ service: PluginService; secretStore: SecretStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-dsplug-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.root, { recursive: true });
  const secretStore = new SecretStore(paths.secrets, fakeCrypto(), new SecretSet());
  await secretStore.load();
  const service = new PluginService({
    paths,
    secretStore,
    mcp: new FakeMcp() as unknown as import('../src/mcp/manager.ts').McpManager,
    builtinPluginsDir: BUILTIN_DIR,
    listBots: async () => [],
    enableForMainBot: async () => undefined,
    removeFromAllBots: async () => undefined,
    providerKey: () => getKey(),
  });
  await service.registerBuiltin();
  return { service, secretStore };
}

test('复用服务 Key：连接选 providerId，之后服务换 Key，不重连也用当前 Key', async () => {
  let key: string | null = 'sk-old';
  const { service, secretStore } = await pluginService(() => key);
  await service.connect('deepseek', { providerId: 'svc' });
  const envKey = async (): Promise<unknown> => {
    const configs = await service.serverConfigs();
    const ds = configs.find((c) => c.origin.kind === 'plugin' && c.origin.pluginId === 'deepseek')!;
    assert.equal(ds.transport.type, 'stdio');
    if (ds.transport.type !== 'stdio') return undefined;
    assert.equal(ds.transport.command, process.execPath);
    assert.deepEqual(ds.transport.env['ELECTRON_RUN_AS_NODE'], { secret: false, value: '1' });
    return ds.transport.env['DEEPSEEK_API_KEY'];
  };
  assert.deepEqual(await envKey(), { secret: false, value: 'sk-old' });
  key = 'sk-new';
  assert.deepEqual(await envKey(), { secret: false, value: 'sk-new' });
  // 不再把服务 Key 复制一份进密钥库
  assert.equal(await secretStore.get('mcp:plugin:deepseek:deepseek:env:DEEPSEEK_API_KEY'), null);
});

test('复用服务被删：重连报错，列表状态 error', async () => {
  let key: string | null = 'sk-old';
  const { service } = await pluginService(() => key);
  await service.connect('deepseek', { providerId: 'svc' });
  key = null;
  await assert.rejects(service.connect('deepseek', { providerId: 'svc' }), /所选的 DeepSeek 服务不存在或没有 API Key/);
  const views = await service.list();
  assert.equal(views.find((v) => v.name === 'deepseek')!.status, 'error');
});
