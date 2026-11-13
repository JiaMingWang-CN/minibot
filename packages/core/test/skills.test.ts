import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPaths, type DataPaths } from '../src/paths.ts';
import { newBot } from '../src/config/config.ts';
import type { Bot } from '../src/config/types.ts';
import { readSkill, splitFrontmatter } from '../src/skills/skill.ts';
import { SkillService, type PluginSkillDirs } from '../src/skills/store.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const PDF_FIXTURE = path.join(here, 'fixtures', 'skills', 'pdf-tools');

async function tempSkillDir(name: string, content: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-skill-'));
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), content);
  return dir;
}

interface Harness {
  paths: DataPaths;
  service: SkillService;
  bots: Bot[];
}

async function harness(pluginSkillDirs: PluginSkillDirs[] = []): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-skillsvc-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.root, { recursive: true });
  const bots: Bot[] = [newBot('main'), newBot('other')];
  const service = new SkillService({
    paths,
    loadPluginSkillDirs: async () => pluginSkillDirs,
    enableForMainBot: async (_kind, id) => {
      if (!bots[0]!.extensions.skills.includes(id)) bots[0]!.extensions.skills = [...bots[0]!.extensions.skills, id];
    },
    removeFromAllBots: async (_kind, id) => {
      for (const bot of bots) bot.extensions.skills = bot.extensions.skills.filter((x) => x !== id);
    },
  });
  return { paths, service, bots };
}

test('合规：name、description 正确', async () => {
  const info = await readSkill(PDF_FIXTURE, { kind: 'user' });
  assert.equal(info.name, 'pdf-tools');
  assert.match(info.description, /处理 PDF/);
  assert.equal(info.id, 'user:pdf-tools');
});

test('BOM 与 CRLF：解析结果与普通内容相同', async () => {
  const plain = await tempSkillDir('bom', '---\nname: bom\ndescription: 描述文本\n---\n\n正文\n');
  const weird = await tempSkillDir('bom2', '\uFEFF---\r\nname: bom2\r\ndescription: 描述文本\r\n---\r\n\r\n正文\r\n');
  const a = await readSkill(plain, { kind: 'user' });
  const b = await readSkill(weird, { kind: 'user' });
  assert.equal(a.description, b.description);
});

test('缺少 frontmatter', async () => {
  const dir = await tempSkillDir('nofm', '只是一段正文\n');
  await assert.rejects(readSkill(dir, { kind: 'user' }), /缺少 frontmatter/);
  assert.equal(splitFrontmatter('正文'), null);
});

test('目录名不一致：name 必须与目录名一致', async () => {
  const dir = await tempSkillDir('a', '---\nname: b\ndescription: d\n---\n\n正文\n');
  await assert.rejects(readSkill(dir, { kind: 'user' }), /name 必须与目录名一致/);
});

test('description 超长：1025 字符被拒', async () => {
  const dir = await tempSkillDir('long', `---\nname: long\ndescription: ${'a'.repeat(1025)}\n---\n\n正文\n`);
  await assert.rejects(readSkill(dir, { kind: 'user' }), /description 必须是 1–1024 个字符/);
});

test('allowed-tools 忽略：正常加载且无相关字段', async () => {
  const dir = await tempSkillDir('tools', '---\nname: tools\ndescription: d\nallowed-tools: Bash(*)\n---\n\n正文\n');
  const info = await readSkill(dir, { kind: 'user' });
  assert.equal(info.name, 'tools');
  assert.equal('allowedTools' in info, false);
});

test('同名遮蔽：单独添加可用，插件那个 shadowed', async () => {
  const pluginDir = await tempSkillDir('pdf-tools', '---\nname: pdf-tools\ndescription: 插件版\n---\n\n正文\n');
  const h = await harness([{ pluginName: 'p', dirs: [pluginDir] }]);
  await fs.mkdir(h.paths.skillsDir, { recursive: true });
  await fs.cp(PDF_FIXTURE, path.join(h.paths.skillsDir, 'pdf-tools'), { recursive: true });
  const { skills } = await h.service.list();
  const userSkill = skills.find((s) => s.id === 'user:pdf-tools')!;
  const pluginSkill = skills.find((s) => s.id === 'plugin:p:pdf-tools')!;
  assert.equal(userSkill.shadowed, false);
  assert.equal(pluginSkill.shadowed, true);
});

test('添加默认主 bot：只有主 bot 的 extensions.skills 含其 id', async () => {
  const h = await harness();
  const info = await h.service.add(PDF_FIXTURE);
  assert.equal(info.id, 'user:pdf-tools');
  assert.deepEqual(h.bots[0]!.extensions.skills, ['user:pdf-tools']);
  assert.deepEqual(h.bots[1]!.extensions.skills, []);
  assert.equal(await fs.stat(path.join(h.paths.skillsDir, 'pdf-tools', 'SKILL.md')).then(() => true, () => false), true);
});

test('删除插件 skill 被拒', async () => {
  const h = await harness();
  await assert.rejects(h.service.remove('plugin:x:y'), /只能删除单独添加的 skill/);
});

test('删除时拒绝不合规的名字，不会删到 skills 目录之外', async () => {
  const h = await harness();
  await fs.mkdir(h.paths.skillsDir, { recursive: true });
  for (const id of ['user:..', 'user:', 'user:../x', 'user:a/b']) {
    await assert.rejects(h.service.remove(id), /skill 名称不合规/);
  }
  assert.equal(await fs.stat(h.paths.skillsDir).then(() => true, () => false), true);
  assert.equal(await fs.stat(h.paths.root).then(() => true, () => false), true);
});
