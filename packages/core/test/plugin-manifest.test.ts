import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPluginBundle, resolvePluginServers, PluginError } from '../src/plugins/manifest.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures', 'plugins');

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minibot-plugin-'));
}

async function writePlugin(dir: string, manifest: unknown, mcp?: unknown, skills: string[] = []): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'minibot-plugin.json'), JSON.stringify(manifest, null, 2));
  if (mcp !== undefined) await fs.writeFile(path.join(dir, 'mcp.json'), JSON.stringify(mcp, null, 2));
  for (const name of skills) {
    const skillDir = path.join(dir, 'skills', name);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\n正文\n`);
  }
}

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'good-plugin', version: '1.0.0', description: '说明', ...overrides };
}

test('合规插件：清单、一个 stdio server、一个 skill 目录', async () => {
  const bundle = await readPluginBundle(path.join(fixtures, 'ok-plugin'));
  assert.equal(bundle.manifest.name, 'ok-plugin');
  assert.equal(bundle.manifest.version, '1.0.0');
  assert.equal(bundle.mcp.length, 1);
  assert.equal(bundle.mcp[0]!.name, 'weather');
  assert.equal(bundle.skillDirs.length, 1);
  assert.equal(path.basename(bundle.skillDirs[0]!), 'weather-report');
  assert.deepEqual(bundle.problems, []);
});

test('缺清单：缺少 minibot-plugin.json', async () => {
  const dir = await tempDir();
  await assert.rejects(readPluginBundle(dir), (err: unknown) => {
    assert.ok(err instanceof PluginError);
    assert.match((err as Error).message, /插件格式错误：缺少 minibot-plugin\.json/);
    return true;
  });
});

test('非法名：My--Plugin 失败并说明名字规则', async () => {
  const dir = await tempDir();
  await writePlugin(dir, baseManifest({ name: 'My--Plugin' }));
  await assert.rejects(readPluginBundle(dir), (err: unknown) => {
    assert.ok(err instanceof PluginError);
    assert.match((err as Error).message, /插件格式错误：/);
    assert.match((err as Error).message, /name/);
    return true;
  });
});

test('未声明配置：args 里 ${config.TOKEN}，清单没有 TOKEN → 失败', async () => {
  const dir = await tempDir();
  await writePlugin(
    dir,
    baseManifest(),
    { mcpServers: { s: { command: 'node', args: ['${config.TOKEN}'] } } },
  );
  await assert.rejects(readPluginBundle(dir), (err: unknown) => {
    assert.match((err as Error).message, /插件格式错误：mcp\.json 引用了未声明的配置：TOKEN/);
    return true;
  });
});

test('替换：${PLUGIN_ROOT} 与 ${config.K}', async () => {
  const dir = await tempDir();
  await writePlugin(
    dir,
    baseManifest({
      config: [{ key: 'K', title: 'k', description: 'k', secret: false, required: true }],
    }),
    { mcpServers: { s: { command: 'node', args: ['${PLUGIN_ROOT}/server.js', '--key=${config.K}'] } } },
  );
  const bundle = await readPluginBundle(dir);
  const servers = resolvePluginServers(bundle, { K: 'abc' });
  assert.equal(servers.length, 1);
  const transport = servers[0]!.transport;
  assert.equal(transport.type, 'stdio');
  if (transport.type !== 'stdio') return;
  assert.deepEqual(transport.args, [`${bundle.root}/server.js`, '--key=abc']);
});

test('不二次替换：配置值本身是 ${PLUGIN_ROOT} → 保持字面', async () => {
  const dir = await tempDir();
  await writePlugin(
    dir,
    baseManifest({
      config: [{ key: 'K', title: 'k', description: 'k', secret: false, required: true }],
    }),
    { mcpServers: { s: { command: 'node', args: ['--v=${config.K}'] } } },
  );
  const bundle = await readPluginBundle(dir);
  const servers = resolvePluginServers(bundle, { K: '${PLUGIN_ROOT}' });
  const transport = servers[0]!.transport;
  assert.equal(transport.type, 'stdio');
  if (transport.type !== 'stdio') return;
  assert.deepEqual(transport.args, ['--v=${PLUGIN_ROOT}']);
});

test('secret 配置项：env 值标记为 secret', async () => {
  const dir = await tempDir();
  await writePlugin(
    dir,
    baseManifest({
      config: [{ key: 'API_KEY', title: 'k', description: 'k', secret: true, required: true }],
    }),
    { mcpServers: { s: { command: 'node', args: [], env: { API_KEY: '${config.API_KEY}' } } } },
  );
  const bundle = await readPluginBundle(dir);
  const servers = resolvePluginServers(bundle, { API_KEY: 'sk-1' });
  const transport = servers[0]!.transport;
  assert.equal(transport.type, 'stdio');
  if (transport.type !== 'stdio') return;
  assert.deepEqual(transport.env['API_KEY'], { value: 'sk-1', secret: true });
});

test('mcp.json 缺失 → mcp 为空、不报错', async () => {
  const dir = await tempDir();
  await writePlugin(dir, baseManifest());
  const bundle = await readPluginBundle(dir);
  assert.deepEqual(bundle.mcp, []);
});

test('skill 目录缺 SKILL.md → 写进 problems，不阻止', async () => {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, 'skills', 'broken'), { recursive: true });
  await writePlugin(dir, baseManifest());
  const bundle = await readPluginBundle(dir);
  assert.equal(bundle.skillDirs.length, 1);
  assert.ok(bundle.problems.some((p) => p.includes('broken')));
});

test('config 键重复 / 非法键名 → 失败', async () => {
  const dir = await tempDir();
  await writePlugin(dir, baseManifest({ config: [
    { key: 'A', title: 'a', description: 'a', secret: false, required: true },
    { key: 'A', title: 'b', description: 'b', secret: false, required: false },
  ] }));
  await assert.rejects(readPluginBundle(dir), (err: unknown) => {
    assert.ok(err instanceof PluginError);
    return true;
  });
});
