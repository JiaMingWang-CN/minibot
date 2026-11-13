import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths } from '../src/paths.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import { SecretStore, type KeyCrypto } from '../src/secrets/store.ts';
import {
  assertUniqueServerName,
  loadMcpServers,
  materializeServer,
  parseMcpJson,
  saveMcpServers,
  shortNameFrom,
} from '../src/mcp/config.ts';

function fakeCrypto(): KeyCrypto {
  return {
    backend: () => 'os',
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decrypt: (buf) => Buffer.from(buf.toString('utf8').slice(4), 'base64').toString('utf8'),
  };
}

test('解析 stdio：args / env，敏感名字默认标 secret', () => {
  const { servers, ignored } = parseMcpJson(
    '{"mcpServers":{"fs":{"command":"npx","args":["-y","x"],"env":{"API_KEY":"k"}}}}',
  );
  assert.deepEqual(ignored, []);
  const draft = servers[0]!;
  assert.equal(draft.name, 'fs');
  assert.equal(draft.shortName, 'fs');
  assert.equal(draft.transport.type, 'stdio');
  if (draft.transport.type !== 'stdio') throw new Error('type');
  assert.equal(draft.transport.command, 'npx');
  assert.deepEqual(draft.transport.args, ['-y', 'x']);
  assert.deepEqual(draft.transport.env['API_KEY'], { value: 'k', secret: true });
  assert.equal(draft.timeoutMs, 60000);
});

test('解析 http：headers，Authorization 默认 secret', () => {
  const { servers } = parseMcpJson(
    '{"mcpServers":{"n":{"url":"https://a.example/mcp","headers":{"Authorization":"Bearer t"}}}}',
  );
  const draft = servers[0]!;
  assert.equal(draft.transport.type, 'http');
  if (draft.transport.type !== 'http') throw new Error('type');
  assert.equal(draft.transport.url, 'https://a.example/mcp');
  assert.deepEqual(draft.transport.headers['Authorization'], { value: 'Bearer t', secret: true });
  assert.equal(draft.transport.auth, 'none');
});

test('忽略未知字段，草稿仍生成', () => {
  const { servers, ignored } = parseMcpJson(
    '{"mcpServers":{"fs":{"command":"npx","disabled":true,"autoApprove":["x"]}}}',
  );
  assert.equal(servers.length, 1);
  assert.ok(ignored.includes('disabled'));
  assert.ok(ignored.includes('autoApprove'));
});

test('sse 不支持：不生成草稿，ignored 含 server 名', () => {
  const { servers, ignored } = parseMcpJson('{"mcpServers":{"old":{"type":"sse","url":"https://x/sse"}}}');
  assert.equal(servers.length, 0);
  assert.ok(ignored.includes('old'));
});

test('shortName：非法字符换成下划线并截断', () => {
  assert.equal(shortNameFrom('我的 Notion!'), '___Notion_');
  assert.equal(shortNameFrom(''), 'mcp');
  assert.equal(shortNameFrom('abcdefghijklmnopqrstuvwxyz'), 'abcdefghijklmnopqrst');
});

test('存取：secret 值只进密钥库，不进 extensions.json', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-mcpcfg-'));
  const p = dataPaths(root);
  const { servers } = parseMcpJson(
    '{"mcpServers":{"fs":{"command":"npx","args":["-y","x"],"env":{"API_KEY":"sk-mcp-secret-123","PLAIN":"visible"}}}}',
  );
  const { config, secrets } = materializeServer('s1', servers[0]!);
  assert.deepEqual(config.transport, {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'x'],
    cwd: null,
    env: { API_KEY: { secret: true }, PLAIN: { secret: false, value: 'visible' } },
  });
  assert.deepEqual(secrets, [{ key: 'mcp:s1:env:API_KEY', value: 'sk-mcp-secret-123' }]);

  const store = new SecretStore(p.secrets, fakeCrypto(), new SecretSet());
  for (const entry of secrets) await store.set(entry.key, entry.value);
  await saveMcpServers(p, [config]);

  const reread = await loadMcpServers(p);
  assert.deepEqual(reread, [config]);
  const text = await fs.readFile(p.extensionsJson, 'utf8');
  assert.equal(text.includes('sk-mcp-secret-123'), false);
  assert.equal(store.get('mcp:s1:env:API_KEY'), 'sk-mcp-secret-123');
});

test('同名 server 拒绝保存', () => {
  const server = materializeServer('s1', parseMcpJson('{"mcpServers":{"a":{"command":"x"}}}').servers[0]!).config;
  assert.throws(() => assertUniqueServerName([server], 'a'), /已有同名的 MCP server/);
});
