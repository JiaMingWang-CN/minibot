import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { dataPaths, type DataPaths } from '../src/paths.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import { SecretStore, type KeyCrypto } from '../src/secrets/store.ts';
import type { McpManager } from '../src/mcp/manager.ts';
import { PluginService, type PluginServiceOptions } from '../src/plugins/registry.ts';

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

interface Harness {
  root: string;
  paths: DataPaths;
  service: PluginService;
}

async function harness(extra: Partial<PluginServiceOptions> = {}): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-install-'));
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
    ...extra,
  });
  return { root, paths, service };
}

async function tempZip(entries: Record<string, Uint8Array>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-zip-'));
  const file = path.join(dir, 'x.zip');
  await fs.writeFile(file, zipSync(entries));
  return file;
}

async function makeRepo(files: Record<string, string>): Promise<{ dir: string; head: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-git-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, head: git('rev-parse', 'HEAD') };
}

test('文件夹安装：预览含命令行，确认后落盘并登记来源 local', async () => {
  const h = await harness();
  const preview = await h.service.prepareInstall({ kind: 'folder', path: OK_PLUGIN });
  assert.equal(preview.manifest.name, 'ok-plugin');
  const stdio = preview.servers.find((s) => s.type === 'stdio');
  assert.ok(stdio !== undefined);
  assert.match(stdio!.commandLine ?? '', /server\.js/);
  assert.ok(preview.skills.includes('weather-report'));

  await h.service.confirmInstall(preview.token);
  assert.equal(await fs.stat(path.join(h.paths.pluginsDir, 'ok-plugin', 'minibot-plugin.json')).then(() => true, () => false), true);
  const installed = await h.service.installed();
  assert.equal(installed.length, 1);
  assert.equal(installed[0]!.source.kind, 'local');
});

test('取消清理：临时目录不存在、未登记', async () => {
  const h = await harness();
  const preview = await h.service.prepareInstall({ kind: 'folder', path: OK_PLUGIN });
  const before = await fs.readdir(h.paths.tmpDir);
  assert.ok(before.some((name) => name.startsWith('plugin-')));
  await h.service.cancelInstall(preview.token);
  const after = await fs.readdir(h.paths.tmpDir);
  assert.equal(after.some((name) => name.startsWith('plugin-')), false);
  assert.equal((await h.service.installed()).length, 0);
});

test('zip 逃逸：../evil.txt 被拒，临时目录已删', async () => {
  const h = await harness();
  const manifest = { name: 'evil', version: '1.0.0', description: 'd' };
  const zip = await tempZip({
    '../evil.txt': strToU8('bad'),
    'minibot-plugin.json': strToU8(JSON.stringify(manifest)),
  });
  await assert.rejects(h.service.prepareInstall({ kind: 'zip', path: zip }), /zip 包含不安全的路径：\.\.\/evil\.txt/);
  const after = await fs.readdir(h.paths.tmpDir).catch(() => [] as string[]);
  assert.equal(after.some((name) => name.startsWith('plugin-')), false);
});

test('zip 炸弹：解压后超限 → 失败', async () => {
  const h = await harness({ zipLimits: { maxBytes: 1024 } });
  const zip = await tempZip({ 'big.bin': new Uint8Array(4096) });
  await assert.rejects(h.service.prepareInstall({ kind: 'zip', path: zip }), /zip 解压后超过 100 MB/);
});

test('Git 安装：本地仓库克隆成功，登记 commit 等于 HEAD', async () => {
  const repo = await makeRepo({
    'minibot-plugin.json': JSON.stringify({ name: 'git-plugin', version: '1.0.0', description: 'd' }),
  });
  const h = await harness({ gitUrlOk: () => true });
  const preview = await h.service.prepareInstall({ kind: 'git', url: repo.dir });
  await h.service.confirmInstall(preview.token);
  const installed = await h.service.installed();
  assert.equal(installed[0]!.source.kind, 'git');
  if (installed[0]!.source.kind === 'git') assert.equal(installed[0]!.source.commit, repo.head);
});

test('非 https：git@github.com 被拒', async () => {
  const h = await harness();
  await assert.rejects(
    h.service.prepareInstall({ kind: 'git', url: 'git@github.com:x/y' }),
    /只支持 https:\/\/ 开头的 Git 地址/,
  );
});

test('重名：再装一次同名 → 已安装同名插件', async () => {
  const h = await harness();
  const first = await h.service.prepareInstall({ kind: 'folder', path: OK_PLUGIN });
  await h.service.confirmInstall(first.token);
  await assert.rejects(h.service.prepareInstall({ kind: 'folder', path: OK_PLUGIN }), /已安装同名插件：ok-plugin/);
});
