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
  assert.deepEqual(f, { schemaVersion: 1, web: { fetchEnabled: true, searchEngine: 'none' }, mcpServers: [] });
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
  assert.equal(await fs.readFile(`${p.extensionsJson}.bad`, 'utf8'), '{ not json');
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
