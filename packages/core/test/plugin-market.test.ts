import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dataPaths, type DataPaths } from '../src/paths.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import { SecretStore, type KeyCrypto } from '../src/secrets/store.ts';
import type { McpManager } from '../src/mcp/manager.ts';
import { PluginService } from '../src/plugins/registry.ts';

function fakeCrypto(): KeyCrypto {
  return {
    backend: () => 'os',
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decrypt: (buf) => Buffer.from(buf.toString('utf8').slice(4), 'base64').toString('utf8'),
  };
}

function fakeMcp(): McpManager {
  return {
    states: () => [],
    connect: async () => undefined,
    disconnect: async () => undefined,
    sync: async () => undefined,
  } as unknown as McpManager;
}

async function harness(): Promise<{ paths: DataPaths; service: PluginService }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-market-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.root, { recursive: true });
  const secretStore = new SecretStore(paths.secrets, fakeCrypto(), new SecretSet());
  await secretStore.load();
  const service = new PluginService({
    paths,
    secretStore,
    mcp: fakeMcp(),
    listBots: async () => [],
    enableForMainBot: async () => undefined,
    removeFromAllBots: async () => undefined,
    gitUrlOk: () => true,
  });
  return { paths, service };
}

async function makeMarketRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-mrepo-'));
  await fs.mkdir(path.join(dir, 'plugins', 'good'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'plugins', 'good', 'minibot-plugin.json'),
    JSON.stringify({ name: 'good', version: '1.0.0', description: '好的插件' }),
  );
  const marketplace = {
    name: 'test-market',
    plugins: [
      { name: 'good', description: '好的插件', version: '1.0.0', source: { git: dir, path: 'plugins/good' } },
      { name: 'bad', description: '缺 source', version: '1.0.0' },
    ],
  };
  await fs.writeFile(path.join(dir, 'marketplace.json'), JSON.stringify(marketplace, null, 2));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('市场：listMarket 跳过不合规条目，按名字安装并登记来源 market', async () => {
  const repo = await makeMarketRepo();
  const h = await harness();
  const entries = await h.service.listMarket(repo);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.name, 'good');

  const preview = await h.service.prepareInstall({ kind: 'market', marketUrl: repo, name: 'good' });
  assert.equal(preview.manifest.name, 'good');
  await h.service.confirmInstall(preview.token);
  const installed = await h.service.installed();
  assert.equal(installed.length, 1);
  assert.equal(installed[0]!.source.kind, 'market');
  if (installed[0]!.source.kind === 'market') {
    assert.equal(installed[0]!.source.marketUrl, repo);
    assert.equal(installed[0]!.source.path, 'plugins/good');
  }
});

test('市场里没有这个插件', async () => {
  const repo = await makeMarketRepo();
  const h = await harness();
  await assert.rejects(
    h.service.prepareInstall({ kind: 'market', marketUrl: repo, name: 'nope' }),
    /市场里没有这个插件：nope/,
  );
});

test('addMarket 只接受 https', async () => {
  const h = await harness();
  const strict = new PluginService({
    paths: h.paths,
    secretStore: new SecretStore(h.paths.secrets, fakeCrypto(), new SecretSet()),
    mcp: fakeMcp(),
    listBots: async () => [],
    enableForMainBot: async () => undefined,
    removeFromAllBots: async () => undefined,
  });
  await assert.rejects(strict.addMarket('git@github.com:x/y'), /只支持 https:\/\/ 开头的 Git 地址/);
  await strict.addMarket('https://example.com/market.git');
  assert.deepEqual(await strict.markets(), ['https://example.com/market.git']);
  await strict.removeMarket('https://example.com/market.git');
  assert.deepEqual(await strict.markets(), []);
});

test('市场条目 path 越出仓库（.. 或绝对路径）按不合规跳过', async () => {
  const { readMarketEntries } = await import('../src/plugins/market.ts');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-mpath-'));
  const marketplace = {
    name: 'm',
    plugins: [
      { name: 'up', description: '', version: '1', source: { git: 'https://x/y', path: '../outside' } },
      { name: 'abs', description: '', version: '1', source: { git: 'https://x/y', path: path.resolve(os.tmpdir()) } },
      { name: 'ok', description: '', version: '1', source: { git: 'https://x/y', path: 'plugins/ok' } },
    ],
  };
  await fs.writeFile(path.join(dir, 'marketplace.json'), JSON.stringify(marketplace));
  const result = await readMarketEntries(dir);
  assert.deepEqual(result.entries.map((e) => e.name), ['ok']);
  assert.equal(result.problems.length, 2);
});
