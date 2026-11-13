import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPaths, type DataPaths } from '../src/paths.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import { SecretStore, type KeyCrypto } from '../src/secrets/store.ts';
import type { McpManager, McpServerState } from '../src/mcp/manager.ts';
import { PluginService } from '../src/plugins/registry.ts';

const BUILTIN_DIR = fileURLToPath(new URL('../../builtin-plugins', import.meta.url));

function fakeCrypto(): KeyCrypto {
  return {
    backend: () => 'os',
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decrypt: (buf) => Buffer.from(buf.toString('utf8').slice(4), 'base64').toString('utf8'),
  };
}

class FakeMcp {
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sync(): Promise<void> {}
  states(): McpServerState[] {
    return [];
  }
}

async function harness(): Promise<{ service: PluginService; paths: DataPaths; secretStore: SecretStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-tv-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.root, { recursive: true });
  const secretStore = new SecretStore(paths.secrets, fakeCrypto(), new SecretSet());
  await secretStore.load();
  const service = new PluginService({
    paths,
    secretStore,
    mcp: new FakeMcp() as unknown as McpManager,
    builtinPluginsDir: BUILTIN_DIR,
    listBots: async () => [],
    enableForMainBot: async () => undefined,
    removeFromAllBots: async () => undefined,
  });
  await service.registerBuiltin();
  return { service, paths, secretStore };
}

test('Tavily 配置：http、地址正确、Authorization 为 secret、URL 不含 Key', async () => {
  const { service, paths, secretStore } = await harness();
  await service.connect('tavily', { api_key: 'tvly-123' });
  const configs = await service.serverConfigs();
  const tavily = configs.find((c) => c.origin.kind === 'plugin' && c.origin.pluginId === 'tavily')!;
  assert.equal(tavily.transport.type, 'http');
  if (tavily.transport.type !== 'http') return;
  assert.equal(tavily.transport.url, 'https://mcp.tavily.com/mcp/');
  assert.equal(tavily.transport.url.includes('tvly-123'), false);
  assert.deepEqual(tavily.transport.headers['Authorization'], { secret: true });
  assert.equal(await secretStore.get('mcp:plugin:tavily:tavily:header:Authorization'), 'Bearer tvly-123');
  const raw = await fs.readFile(paths.extensionsJson, 'utf8');
  assert.equal(raw.includes('tvly-123'), false);
});

test('Tavily OAuth：server 配置 auth=oauth、无 Authorization 头', async () => {
  const { service } = await harness();
  await service.connect('tavily', { oauth: 'true' });
  const configs = await service.serverConfigs();
  const tavily = configs.find((c) => c.origin.kind === 'plugin' && c.origin.pluginId === 'tavily')!;
  assert.equal(tavily.transport.type, 'http');
  if (tavily.transport.type !== 'http') return;
  assert.equal(tavily.transport.auth, 'oauth');
  assert.equal(tavily.transport.headers['Authorization'], undefined);
  assert.equal(tavily.transport.url, 'https://mcp.tavily.com/mcp/');
});
