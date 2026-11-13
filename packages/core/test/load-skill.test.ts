import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPaths } from '../src/paths.ts';
import { newBot } from '../src/config/config.ts';
import { openDb } from '../src/db/db.ts';
import { MemoryRevisions } from '../src/memory/revisions.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import { ReadTracker } from '../src/tools/read-tracker.ts';
import { ApprovalBroker } from '../src/approval/broker.ts';
import { executeTool, type ToolEnv } from '../src/tools/registry.ts';
import { ToolCatalog } from '../src/tools/catalog.ts';
import { buildSystemPrompt } from '../src/agent/prompt.ts';
import { readSkill, type SkillInfo } from '../src/skills/skill.ts';
import { loadSkill, LOAD_SKILL_SPEC } from '../src/skills/load-skill.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const PDF_FIXTURE = path.join(here, 'fixtures', 'skills', 'pdf-tools');

function promptArgs(skills?: { name: string; description: string }[]) {
  return {
    bot: { ...newBot('b1'), persona: '助理' },
    workspace: '/ws',
    userMd: '',
    userMdPath: '/data/user.md',
    memoryDir: '/data/memory',
    topics: [],
    ...(skills !== undefined ? { skills } : {}),
    platform: 'win32' as const,
    now: new Date('2026-11-12T00:00:00Z'),
  };
}

test('摘要：系统提示含名称、描述与约定行，工具列表含 load_skill', async () => {
  const prompt = buildSystemPrompt(promptArgs([{ name: 'pdf-tools', description: '处理 PDF' }]));
  assert.ok(prompt.includes('- pdf-tools：处理 PDF'));
  assert.ok(prompt.includes('先调用 load_skill'));
  const catalog = new ToolCatalog();
  const toolset = await catalog.snapshot(newBot('b1'), [
    { id: 'user:pdf-tools', name: 'pdf-tools', description: '处理 PDF', dir: '/x', origin: { kind: 'user' }, shadowed: false },
  ]);
  assert.ok(toolset.specs.some((s) => s.name === 'load_skill'));
});

test('无 skill：系统提示不含摘要，工具列表不含 load_skill', async () => {
  const prompt = buildSystemPrompt(promptArgs([]));
  assert.equal(prompt.includes('可用的 skill'), false);
  const catalog = new ToolCatalog();
  const toolset = await catalog.snapshot(newBot('b1'), []);
  assert.equal(toolset.specs.some((s) => s.name === 'load_skill'), false);
});

async function envWithToolset(info: SkillInfo, mode: 'ask' | 'edits') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-loadskill-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.defaultWorkspace('b1'), { recursive: true });
  await fs.mkdir(paths.memoryDir('b1'), { recursive: true });
  const db = openDb(paths.db);
  const bot = newBot('b1');
  bot.approvalMode = mode;
  const broker = new ApprovalBroker(() => {});
  const env: ToolEnv = {
    bot,
    threadId: 't1',
    workspace: paths.defaultWorkspace('b1'),
    paths,
    home: path.join(root, 'home'),
    tracker: new ReadTracker(),
    secrets: new SecretSet(),
    revisions: new MemoryRevisions(db, paths),
    broker,
    signal: new AbortController().signal,
    toolset: { specs: [LOAD_SKILL_SPEC], external: () => undefined, skills: [info] },
  };
  return { env, broker, db };
}

test('读正文：第一行是目录，随后正文；ask 档也不发审批', async () => {
  const info = await readSkill(PDF_FIXTURE, { kind: 'user' });
  const { env, broker, db } = await envWithToolset(info, 'ask');
  try {
    const result = await executeTool({ type: 'tool_use', id: 'tu1', name: 'load_skill', input: { name: 'pdf-tools' } }, env);
    assert.equal(result.status, 'ok');
    assert.ok(result.content.startsWith(`skill 目录：${info.dir}`));
    assert.ok(result.content.includes('PDF 工具'));
    assert.equal(broker.pending().length, 0);
  } finally {
    db.close();
  }
});

test('读引用文件：path: references/a.md', async () => {
  const info = await readSkill(PDF_FIXTURE, { kind: 'user' });
  const content = await loadSkill([info], { name: 'pdf-tools', path: 'references/a.md' });
  assert.ok(content.includes('参考内容'));
});

test('越界：path ../other/SKILL.md → 路径超出 skill 目录', async () => {
  const info = await readSkill(PDF_FIXTURE, { kind: 'user' });
  await assert.rejects(loadSkill([info], { name: 'pdf-tools', path: '../other/SKILL.md' }), /路径超出 skill 目录/);
});

test('链接越界：目录内符号链接指向外部被拒', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-link-'));
  const skillDir = path.join(root, 'linky');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: linky\ndescription: d\n---\n\n正文\n');
  const outside = path.join(root, 'outside.txt');
  await fs.writeFile(outside, 'secret');
  try {
    await fs.symlink(outside, path.join(skillDir, 'leak.txt'));
  } catch {
    return; // 环境不支持建符号链接，跳过
  }
  const info = await readSkill(skillDir, { kind: 'user' });
  await assert.rejects(loadSkill([info], { name: 'linky', path: 'leak.txt' }), /路径超出 skill 目录/);
});

test('摘要截断：200 个 skill 不超 8000 字符，末尾有“还有 n 个”，未列出的仍可读', async () => {
  const skills = Array.from({ length: 200 }, (_v, i) => ({ name: `s${i}`, description: 'a'.repeat(100) }));
  const prompt = buildSystemPrompt(promptArgs(skills));
  const section = prompt.slice(prompt.indexOf('可用的 skill：'));
  assert.ok(section.length <= 8000, `section 长度 ${section.length}`);
  assert.match(section, /还有 \d+ 个 skill 未列出/);

  const unlistedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-s199-'));
  const dir = path.join(unlistedDir, 's199');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: s199\ndescription: d\n---\n\n正文199\n');
  const unlisted = await readSkill(dir, { kind: 'user' });
  const text = await loadSkill([unlisted], { name: 's199' });
  assert.ok(text.startsWith(`skill 目录：${unlisted.dir}`));
  assert.ok(text.includes('正文199'));
});

test('未启用不可读：读不存在的 skill → 没有这个 skill', async () => {
  await assert.rejects(loadSkill([], { name: 'nope' }), /没有这个 skill：nope/);
});

test('读超长引用文件：结果按统一上限截断，全文写进 outputs', async () => {
  const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-bigskill-')), 'big-skill');
  await fs.mkdir(path.join(dir, 'references'), { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), ['---', 'name: big-skill', 'description: 大文件', '---', '正文', ''].join('\n'));
  await fs.writeFile(path.join(dir, 'references', 'big.md'), 'x'.repeat(100_000));
  const info = await readSkill(dir, { kind: 'user' });
  const { env, db } = await envWithToolset(info, 'edits');
  try {
    const result = await executeTool(
      { type: 'tool_use', id: 'tu9', name: 'load_skill', input: { name: 'big-skill', path: 'references/big.md' } },
      env,
    );
    assert.equal(result.status, 'ok');
    assert.ok(result.content.length < 40_000);
    assert.ok(result.content.includes('完整输出见'));
  } finally {
    db.close();
  }
});
