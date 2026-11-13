import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dataPaths, type DataPaths } from '../src/paths.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import { SecretStore, type KeyCrypto } from '../src/secrets/store.ts';
import type { McpManager, McpServerState } from '../src/mcp/manager.ts';
import { PluginService } from '../src/plugins/registry.ts';
import { moveDir } from '../src/plugins/install.ts';

function fakeCrypto(): KeyCrypto {
  return {
    backend: () => 'os',
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decrypt: (buf) => Buffer.from(buf.toString('utf8').slice(4), 'base64').toString('utf8'),
  };
}

class FakeMcp {
  connected = new Set<string>();

  async connect(id: string): Promise<void> {
    this.connected.add(id);
  }

  async disconnect(id: string): Promise<void> {
    this.connected.delete(id);
  }

  async sync(): Promise<void> {}

  states(): McpServerState[] {
    return [...this.connected].map((id) => ({ id, status: 'connected', error: null, tools: [] }));
  }
}

interface Harness {
  paths: DataPaths;
  service: PluginService;
  mcp: FakeMcp;
}

async function harness(extra: { moveDirImpl?: (s: string, d: string) => Promise<void> } = {}): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-update-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.root, { recursive: true });
  const secretStore = new SecretStore(paths.secrets, fakeCrypto(), new SecretSet());
  await secretStore.load();
  const mcp = new FakeMcp();
  const service = new PluginService({
    paths,
    secretStore,
    mcp: mcp as unknown as McpManager,
    listBots: async () => [],
    enableForMainBot: async () => undefined,
    removeFromAllBots: async () => undefined,
    gitUrlOk: () => true,
    ...(extra.moveDirImpl !== undefined ? { moveDirImpl: extra.moveDirImpl } : {}),
  });
  return { paths, service, mcp };
}

const MANIFEST_V1 = { name: 'upd', version: '1.0.0', description: 'd', config: [{ key: 'K', title: 'K', description: 'K', secret: false, required: true }] };
const MCP_V1 = { mcpServers: { srv: { command: 'node', args: ['${PLUGIN_ROOT}/server.js', '${config.K}'] } } };

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-uprepo-'));
  await fs.writeFile(path.join(dir, 'minibot-plugin.json'), JSON.stringify(MANIFEST_V1));
  await fs.writeFile(path.join(dir, 'mcp.json'), JSON.stringify(MCP_V1));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'v1');
  return dir;
}

async function commitV2(dir: string, overrides: { manifest?: unknown; mcp?: unknown } = {}): Promise<string> {
  const manifest = overrides.manifest ?? { ...MANIFEST_V1, version: '2.0.0' };
  const mcp = overrides.mcp ?? { mcpServers: { srv: { command: 'node', args: ['${PLUGIN_ROOT}/server.js', '${config.K}', '--new'] } } };
  await fs.writeFile(path.join(dir, 'minibot-plugin.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(dir, 'mcp.json'), JSON.stringify(mcp));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'v2');
  return git(dir, 'rev-parse', 'HEAD');
}

async function installAndConnect(h: Harness, repo: string): Promise<void> {
  const preview = await h.service.prepareInstall({ kind: 'git', url: repo });
  await h.service.confirmInstall(preview.token);
  await h.service.connect('upd', { K: 'v1' });
}

test('发现更新、命令变化、确认更新后保留配置', async () => {
  const repo = await makeRepo();
  const h = await harness();
  await installAndConnect(h, repo);
  assert.deepEqual(await h.service.checkUpdates(), []);
  assert.ok(h.mcp.connected.has('plugin:upd:srv'));

  const head = await commitV2(repo);
  const updates = await h.service.checkUpdates();
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.latest, head.slice(0, 7));

  const preview = await h.service.prepareUpdate('upd');
  const change = preview.commandChanges.find((c) => c.server === 'srv');
  assert.ok(change !== undefined);
  assert.match(change!.before ?? '', /\$\{config\.K\}/);
  assert.match(change!.after ?? '', /--new/);

  await h.service.confirmUpdate(preview.token);
  const installed = (await h.service.installed())[0]!;
  assert.equal(installed.version, '2.0.0');
  assert.equal(installed.config?.['K'], 'v1');
  assert.ok(h.mcp.connected.has('plugin:upd:srv'));
});

test('失败回滚：新版本清单不合规 → prepareUpdate 失败，旧版本仍 connected', async () => {
  const repo = await makeRepo();
  const h = await harness();
  await installAndConnect(h, repo);
  await commitV2(repo, { manifest: { name: 'Bad--Name', version: '2.0.0', description: 'd' } });
  await assert.rejects(h.service.prepareUpdate('upd'));
  assert.ok(h.mcp.connected.has('plugin:upd:srv'));
  assert.equal((await h.service.installed())[0]!.version, '1.0.0');
});

test('安装失败回滚：模拟移动新目录失败 → 旧目录恢复、旧 server 重新连接', async () => {
  const repo = await makeRepo();
  const h = await harness({
    moveDirImpl: async (src, dest) => {
      if (src.includes('plugin-update-')) throw new Error('模拟移动失败');
      await moveDir(src, dest);
    },
  });
  await installAndConnect(h, repo);
  await commitV2(repo);
  const preview = await h.service.prepareUpdate('upd');
  await assert.rejects(h.service.confirmUpdate(preview.token), /模拟移动失败/);
  const installed = (await h.service.installed())[0]!;
  assert.equal(installed.version, '1.0.0');
  const manifest = JSON.parse(await fs.readFile(path.join(h.paths.pluginsDir, 'upd', 'minibot-plugin.json'), 'utf8')) as { version: string };
  assert.equal(manifest.version, '1.0.0');
  assert.ok(h.mcp.connected.has('plugin:upd:srv'));
});
