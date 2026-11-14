import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { dataPaths, type DataPaths } from '../src/paths.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import { SecretStore, type KeyCrypto } from '../src/secrets/store.ts';
import type { McpManager } from '../src/mcp/manager.ts';
import { PluginService, type PluginServiceOptions } from '../src/plugins/registry.ts';
import { loadExtensions, saveExtensions } from '../src/extensions/store.ts';
import { moveDir } from '../src/plugins/install.ts';
import { assertGitUrl } from '../src/plugins/sources.ts';
import { cacheDirFor } from '../src/plugins/market.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const OK_PLUGIN = path.join(here, 'fixtures', 'plugins', 'ok-plugin');

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

async function harness(extra: Partial<PluginServiceOptions> = {}): Promise<{ paths: DataPaths; service: PluginService; removed: string[] }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-b6-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.root, { recursive: true });
  const secretStore = new SecretStore(paths.secrets, fakeCrypto(), new SecretSet());
  await secretStore.load();
  const removed: string[] = [];
  const service = new PluginService({
    paths,
    secretStore,
    mcp: fakeMcp(),
    listBots: async () => [],
    enableForMainBot: async () => undefined,
    removeFromAllBots: async (_kind, id) => {
      removed.push(id);
    },
    ...extra,
  });
  return { paths, service, removed };
}

async function builtinDirWith(...names: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-b6-builtin-'));
  for (const name of names) {
    await fs.mkdir(path.join(dir, name), { recursive: true });
    await fs.writeFile(path.join(dir, name, 'minibot-plugin.json'), JSON.stringify({ name, version: '2.0.0', description: 'd' }));
  }
  return dir;
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true, () => false);
}

test('registerBuiltin：已登记的同名第三方插件不被改成 builtin', async () => {
  const dir = await builtinDirWith('clash');
  const h = await harness({ builtinPluginsDir: dir });
  const file = await loadExtensions(h.paths);
  file.plugins.push({ name: 'clash', version: '1.0.0', builtin: false, source: { kind: 'local' }, enabled: true, serverIds: [] });
  await saveExtensions(h.paths, file);
  await h.service.registerBuiltin();
  const plugin = (await loadExtensions(h.paths)).plugins.find((p) => p.name === 'clash')!;
  assert.equal(plugin.builtin, false);
  assert.deepEqual(plugin.source, { kind: 'local' });
  assert.equal(plugin.version, '1.0.0');
});

test('registerBuiltin：预装目录里已不存在的 builtin 登记被清掉，并从各 bot 移除；仍存在的保留', async () => {
  const dir = await builtinDirWith('keep');
  const h = await harness({ builtinPluginsDir: dir });
  const file = await loadExtensions(h.paths);
  file.plugins.push(
    { name: 'gone', version: '1.0.0', builtin: true, source: { kind: 'builtin' }, enabled: true, serverIds: [] },
    { name: 'third', version: '1.0.0', builtin: false, source: { kind: 'local' }, enabled: true, serverIds: [] },
  );
  await saveExtensions(h.paths, file);
  await h.service.registerBuiltin();
  const names = (await loadExtensions(h.paths)).plugins.map((p) => p.name).sort();
  assert.deepEqual(names, ['keep', 'third']);
  assert.deepEqual(h.removed, ['gone']);
});

test('启动清理：删除 tmp 下 plugin-* 与 plugins 下 *.bak-<数字>；原目录缺失时从备份恢复', async () => {
  const h = await harness();
  await fs.mkdir(path.join(h.paths.tmpDir, 'plugin-abc'), { recursive: true });
  await fs.mkdir(path.join(h.paths.tmpDir, 'plugin-update-def'), { recursive: true });
  await fs.mkdir(path.join(h.paths.tmpDir, 'other'), { recursive: true });
  await fs.mkdir(path.join(h.paths.pluginsDir, 'alive'), { recursive: true });
  await fs.mkdir(path.join(h.paths.pluginsDir, 'alive.bak-123'), { recursive: true });
  await fs.mkdir(path.join(h.paths.pluginsDir, 'lost.bak-456'), { recursive: true });
  await fs.writeFile(path.join(h.paths.pluginsDir, 'lost.bak-456', 'marker'), 'x');
  await fs.mkdir(path.join(h.paths.pluginsDir, 'notbak.bak-x'), { recursive: true });
  await h.service.registerBuiltin();
  assert.deepEqual((await fs.readdir(h.paths.tmpDir)).sort(), ['other']);
  assert.deepEqual((await fs.readdir(h.paths.pluginsDir)).sort(), ['alive', 'lost', 'notbak.bak-x']);
  assert.equal(await exists(path.join(h.paths.pluginsDir, 'lost', 'marker')), true);
});

test('moveDir：rename 遇 EBUSY 会重试，非可重试错误直接抛', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-b6-mv-'));
  let calls = 0;
  const deps = {
    rename: (async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    }) as unknown as typeof fs.rename,
    sleep: async () => undefined,
    now: () => 0,
  };
  await moveDir(path.join(dir, 'a'), path.join(dir, 'b'), deps);
  assert.equal(calls, 3);
  const fatal = { ...deps, rename: (async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); }) as unknown as typeof fs.rename };
  await assert.rejects(moveDir(path.join(dir, 'a'), path.join(dir, 'b'), fatal), /nope/);
});

test('文件夹来源：条目数 / 总大小超限报错并清理临时目录', async () => {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-b6-src-'));
  await fs.writeFile(path.join(src, 'minibot-plugin.json'), JSON.stringify({ name: 'big', version: '1.0.0', description: 'd' }));
  await fs.writeFile(path.join(src, 'a.bin'), Buffer.alloc(4096));
  const bytes = await harness({ zipLimits: { maxBytes: 1024 } });
  await assert.rejects(bytes.service.prepareInstall({ kind: 'folder', path: src }), /超过 100 MB/);
  assert.equal((await fs.readdir(bytes.paths.tmpDir).catch(() => [] as string[])).some((n) => n.startsWith('plugin-')), false);
  const entries = await harness({ zipLimits: { maxEntries: 1 } });
  await assert.rejects(entries.service.prepareInstall({ kind: 'folder', path: src }), /条目超过 5000 个/);
});

test('文件夹来源：符号链接被跳过，不进入插件目录', async (t) => {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-b6-link-'));
  await fs.cp(OK_PLUGIN, src, { recursive: true });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-b6-out-'));
  await fs.writeFile(path.join(outside, 'secret.txt'), 's');
  try {
    await fs.symlink(outside, path.join(src, 'link-dir'));
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(src, 'link-file'));
  } catch {
    t.skip('无法创建符号链接');
    return;
  }
  const h = await harness();
  const preview = await h.service.prepareInstall({ kind: 'folder', path: src });
  await h.service.confirmInstall(preview.token);
  const installed = path.join(h.paths.pluginsDir, 'ok-plugin');
  assert.equal(await exists(path.join(installed, 'minibot-plugin.json')), true);
  const names = await fs.readdir(installed);
  assert.equal(names.includes('link-dir'), false);
  assert.equal(names.includes('link-file'), false);
});

test('zip 顶层套一层目录：识别其中的插件根；根目录已有清单时不下钻', async () => {
  const manifest = strToU8(JSON.stringify({ name: 'wrapped', version: '1.0.0', description: 'd' }));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-b6-zip-'));
  const wrapped = path.join(dir, 'w.zip');
  await fs.writeFile(wrapped, zipSync({ 'wrapped-main/minibot-plugin.json': manifest, 'wrapped-main/readme.md': strToU8('x') }));
  const h = await harness();
  const preview = await h.service.prepareInstall({ kind: 'zip', path: wrapped });
  assert.equal(preview.manifest.name, 'wrapped');
  await h.service.confirmInstall(preview.token);
  assert.equal(await exists(path.join(h.paths.pluginsDir, 'wrapped', 'readme.md')), true);

  const flat = path.join(dir, 'f.zip');
  await fs.writeFile(flat, zipSync({ 'minibot-plugin.json': manifest, 'sub/minibot-plugin.json': strToU8('{}') }));
  const h2 = await harness();
  const p2 = await h2.service.prepareInstall({ kind: 'zip', path: flat });
  assert.equal(p2.manifest.name, 'wrapped');
});

test('removeMarket：同时删除该市场的缓存目录', async () => {
  const h = await harness({ gitUrlOk: () => true });
  const url = 'https://example.com/market.git';
  await h.service.addMarket(url);
  const cache = cacheDirFor(path.join(h.paths.cacheDir, 'markets'), url);
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(cache, 'marketplace.json'), '{}');
  await h.service.removeMarket(url);
  assert.equal(await exists(cache), false);
});

test('Git 地址带用户名 / 密码被拒绝，错误文本不含凭据', async () => {
  assert.throws(() => assertGitUrl('https://user:tok3n@example.com/x.git'), (err: Error) => /不要在地址里带用户名或密码/.test(err.message) && !err.message.includes('tok3n'));
  assert.throws(() => assertGitUrl('https://tok3n@example.com/x.git'), /不要在地址里带用户名或密码/);
  assertGitUrl('https://example.com/x.git');
  const h = await harness();
  await assert.rejects(h.service.addMarket('https://u:p@example.com/m.git'), /不要在地址里带用户名或密码/);
  await assert.rejects(h.service.prepareInstall({ kind: 'git', url: 'https://u:p@example.com/x.git' }), /不要在地址里带用户名或密码/);
});

test('Git 来源：克隆后条目数超限报错并清理临时目录', async () => {
  const { execFileSync } = await import('node:child_process');
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-b6-git-'));
  await fs.writeFile(path.join(repo, 'minibot-plugin.json'), JSON.stringify({ name: 'g', version: '1.0.0', description: 'd' }));
  await fs.writeFile(path.join(repo, 'b.txt'), 'b');
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const h = await harness({ gitUrlOk: () => true, zipLimits: { maxEntries: 3 } });
  await assert.rejects(h.service.prepareInstall({ kind: 'git', url: repo }), /条目超过 5000 个/);
  assert.equal((await fs.readdir(h.paths.tmpDir).catch(() => [] as string[])).some((n) => n.startsWith('plugin-')), false);
});
