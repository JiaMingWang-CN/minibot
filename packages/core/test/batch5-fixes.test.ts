import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPreview } from '../src/plugins/install.ts';
import { diffStdioCommands } from '../src/plugins/update.ts';
import type { PluginBundle } from '../src/plugins/manifest.ts';
import type { McpServerDraft } from '../src/mcp/config.ts';

function bundle(mcp: McpServerDraft[]): PluginBundle {
  return { manifest: { name: 'p', version: '1', description: 'd', config: [] }, root: '/r', mcp, skillDirs: [], problems: [] };
}

function stdio(over: Partial<Extract<McpServerDraft['transport'], { type: 'stdio' }>> = {}): McpServerDraft {
  return {
    name: 's',
    shortName: 's',
    timeoutMs: 1000,
    transport: { type: 'stdio', command: 'npx', args: ['pkg'], cwd: null, env: {}, ...over },
  };
}

function http(url: string, headers: Record<string, { value: string; secret: boolean }> = {}): McpServerDraft {
  return { name: 'h', shortName: 'h', timeoutMs: 1000, transport: { type: 'http', url, headers, auth: 'none' } };
}

test('安装预览展示 env 与 headers（${config.*} 原样显示）', () => {
  const b = bundle([
    stdio({ env: { NODE_OPTIONS: { value: '--require ${PLUGIN_ROOT}/x.js', secret: false }, TOKEN: { value: '${config.TOKEN}', secret: false } } }),
    http('https://a.example/mcp', { Authorization: { value: 'Bearer ${config.TOKEN}', secret: false } }),
  ]);
  const [s, h] = buildPreview('t', b, '/inst').servers;
  assert.deepEqual(s!.env, [
    { name: 'NODE_OPTIONS', value: '--require /inst/x.js' },
    { name: 'TOKEN', value: '${config.TOKEN}' },
  ]);
  assert.deepEqual(h!.headers, [{ name: 'Authorization', value: 'Bearer ${config.TOKEN}' }]);
});

test('更新对比覆盖 env、cwd、url、headers 的变化', () => {
  const old = bundle([stdio(), http('https://a.example/mcp')]);
  assert.deepEqual(diffStdioCommands(old, bundle([stdio(), http('https://a.example/mcp')]), '/inst'), []);

  const envChanged = diffStdioCommands(old, bundle([stdio({ env: { NPM_CONFIG_REGISTRY: { value: 'https://evil', secret: false } } }), http('https://a.example/mcp')]), '/inst');
  assert.equal(envChanged.length, 1);
  assert.match(envChanged[0]!.after ?? '', /NPM_CONFIG_REGISTRY=https:\/\/evil/);

  const cwdChanged = diffStdioCommands(old, bundle([stdio({ cwd: '/tmp' }), http('https://a.example/mcp')]), '/inst');
  assert.equal(cwdChanged[0]!.server, 's');

  const urlChanged = diffStdioCommands(old, bundle([stdio(), http('https://b.example/mcp')]), '/inst');
  assert.equal(urlChanged[0]!.server, 'h');
  assert.match(urlChanged[0]!.after ?? '', /b\.example/);

  const hdr = diffStdioCommands(old, bundle([stdio(), http('https://a.example/mcp', { 'X-A': { value: '1', secret: false } })]), '/inst');
  assert.equal(hdr[0]!.server, 'h');
});

// ---- secrets：mcp:*:oauth 的 JSON 值内的 token 字段单独脱敏 ----
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretSet } from '../src/secrets/redact.ts';
import { SecretStore, type KeyCrypto } from '../src/secrets/store.ts';

const crypto5: KeyCrypto = {
  backend: () => 'os',
  encrypt: (plain) => Buffer.concat([Buffer.from('enc:'), Buffer.from(Buffer.from(plain).toString('base64'))]),
  decrypt: (buf) => Buffer.from(buf.toString('utf8').slice(4), 'base64').toString('utf8'),
};

const OAUTH = JSON.stringify({
  tokens: { access_token: 'AT-secret-value-1', refresh_token: 'RT-secret-value-2', token_type: 'Bearer' },
  clientInformation: { client_id: 'cid', client_secret: 'CS-secret-value-3' },
});

test('mcp:*:oauth：set 后 access/refresh token 与 client_secret 单独脱敏', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-b5-'));
  const set = new SecretSet();
  const store = new SecretStore(path.join(dir, 'secrets.bin'), crypto5, set);
  await store.set('mcp:s1:oauth', OAUTH);
  const out = set.redact('x AT-secret-value-1 y RT-secret-value-2 z CS-secret-value-3');
  assert.doesNotMatch(out, /secret-value/);
});

test('mcp:*:oauth：load 后同样单独脱敏', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-b5-'));
  const file = path.join(dir, 'secrets.bin');
  await new SecretStore(file, crypto5, new SecretSet()).set('mcp:s1:oauth', OAUTH);
  const set = new SecretSet();
  await new SecretStore(file, crypto5, set).load();
  assert.doesNotMatch(set.redact('AT-secret-value-1 RT-secret-value-2 CS-secret-value-3'), /secret-value/);
});
