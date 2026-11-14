import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths } from '../src/paths.ts';
import { loadExtensions, saveExtensions } from '../src/extensions/store.ts';

async function tmpPaths() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-ext-'));
  return dataPaths(root);
}

test('extensions.json 不存在时默认开启抓取、搜索引擎 none', async () => {
  const p = await tmpPaths();
  const f = await loadExtensions(p);
  assert.deepEqual(f, { schemaVersion: 1, web: { fetchEnabled: true, searchEngine: 'none' }, mcpServers: [], plugins: [], markets: [] });
  assert.equal(p.extensionsJson, path.join(p.root, 'extensions.json'));
});

test('写入后再读一致', async () => {
  const p = await tmpPaths();
  const f = await loadExtensions(p);
  f.web.fetchEnabled = false;
  await saveExtensions(p, f);
  const reread = await loadExtensions(p);
  assert.deepEqual(reread.web, { fetchEnabled: false, searchEngine: 'none' });
});

test('未知字段读写后仍在', async () => {
  const p = await tmpPaths();
  await fs.writeFile(
    p.extensionsJson,
    JSON.stringify({ schemaVersion: 1, future: { keep: 'me' }, web: { fetchEnabled: false, searchEngine: 'none' } }),
  );
  const f = await loadExtensions(p);
  assert.deepEqual((f as Record<string, unknown>)['future'], { keep: 'me' });
  f.web.fetchEnabled = true;
  await saveExtensions(p, f);
  const raw = JSON.parse(await fs.readFile(p.extensionsJson, 'utf8'));
  assert.deepEqual(raw.future, { keep: 'me' });
  assert.equal(raw.web.fetchEnabled, true);
});

test('坏文件回退默认值', async () => {
  const p = await tmpPaths();
  await fs.writeFile(p.extensionsJson, '{ not json');
  const f = await loadExtensions(p);
  assert.deepEqual(f.web, { fetchEnabled: true, searchEngine: 'none' });
  // 原文件备份下来，之后保存覆盖也不会丢内容
  const backups = (await fs.readdir(p.root)).filter((n) => n.startsWith('extensions.json.bad-'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(p.root, backups[0]!), 'utf8'), '{ not json');
});

test('坏文件备份名带时间戳，连续两次损坏不互相覆盖', async () => {
  const p = await tmpPaths();
  await fs.writeFile(p.extensionsJson, '{ first');
  await loadExtensions(p);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await fs.writeFile(p.extensionsJson, '{ second');
  await loadExtensions(p);
  const contents = await Promise.all(
    (await fs.readdir(p.root)).filter((n) => n.startsWith('extensions.json.bad-')).map((n) => fs.readFile(path.join(p.root, n), 'utf8')),
  );
  assert.deepEqual(contents.sort(), ['{ first', '{ second']);
});

test('mcpServers 读盘逐项校验：结构不合规的条目被跳过，合规的保留', async () => {
  const p = await tmpPaths();
  const good = {
    id: 'a',
    name: 'good',
    shortName: 'g',
    transport: { type: 'stdio', command: 'node', args: ['x.js'], cwd: null, env: { K: { secret: false, value: 'v' }, S: { secret: true } } },
    timeoutMs: 1000,
    origin: { kind: 'user' },
  };
  const goodHttp = {
    id: 'b',
    name: 'web',
    shortName: 'w',
    transport: { type: 'http', url: 'https://x.test/mcp', headers: {}, auth: 'oauth' },
    timeoutMs: 1000,
    origin: { kind: 'plugin', pluginId: 'p' },
  };
  const bad = [
    null,
    'str',
    { ...good, id: 1 },
    { ...good, transport: undefined },
    { ...good, transport: { type: 'ftp' } },
    { ...good, transport: { ...good.transport, args: 'x' } },
    { ...good, transport: { ...good.transport, env: { K: 'plain' } } },
    { ...goodHttp, transport: { type: 'http', url: 5, headers: {}, auth: 'none' } },
    { ...goodHttp, transport: { ...goodHttp.transport, auth: 'basic' } },
    { ...good, timeoutMs: 'x' },
    { ...good, origin: { kind: 'plugin' } },
  ];
  await fs.writeFile(p.extensionsJson, JSON.stringify({ schemaVersion: 1, mcpServers: [bad[0], good, ...bad.slice(1), goodHttp] }));
  const f = await loadExtensions(p);
  assert.deepEqual(f.mcpServers.map((s) => s.id), ['a', 'b']);
});

test('并发修改联网设置不丢更新', async () => {
  const { kernelHarness } = await import('./kernel-harness.ts');
  const h = await kernelHarness();
  await Promise.all([
    h.kernel.updateWebSettings({ fetchEnabled: false }),
    h.kernel.updateWebSettings({ searchEngine: 'none' }),
  ]);
  assert.equal((await h.kernel.webSettings()).fetchEnabled, false);
  await h.kernel.close();
});
