import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths } from '../src/paths.ts';
import { resolveReal, isInside, classifyPath, type ClassifyContext } from '../src/tools/path-guard.ts';

async function setup(): Promise<{ root: string; ws: string; ctx: ClassifyContext }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-path-'));
  const paths = dataPaths(root);
  const ws = paths.defaultWorkspace('b1');
  await fs.mkdir(ws, { recursive: true });
  await fs.mkdir(paths.memoryDir('b1'), { recursive: true });
  await fs.mkdir(paths.memoryDir('b2'), { recursive: true });
  return {
    root,
    ws,
    ctx: { paths, botId: 'b1', workspace: ws, home: path.join(root, 'home') },
  };
}

test('../ 越界', async () => {
  const { ws, ctx } = await setup();
  const real = await resolveReal('../x', ws, ctx.home);
  assert.equal(classifyPath(real, ctx), 'outside');
});

test('软链接 / junction 逃逸', async () => {
  const { root, ws, ctx } = await setup();
  const outsideDir = path.join(root, 'outside-dir');
  await fs.mkdir(outsideDir, { recursive: true });
  const link = path.join(ws, 'link');
  if (process.platform === 'win32') await fs.symlink(outsideDir, link, 'junction');
  else await fs.symlink(outsideDir, link);
  await fs.writeFile(path.join(outsideDir, 'f.txt'), 'x');
  const real = await resolveReal('link/f.txt', ws, ctx.home);
  assert.equal(classifyPath(real, ctx), 'outside');
});

test('新建文件、父目录不存在', async () => {
  const { ws, ctx } = await setup();
  const real = await resolveReal('a/b/c.txt', ws, ctx.home);
  assert.equal(classifyPath(real, ctx), 'workspace');
  assert.ok(real.startsWith(await fs.realpath(ws)));
});

test('前缀陷阱：C:\\work 与 C:\\work2', () => {
  assert.equal(isInside('C:\\work2\\a', 'C:\\work', 'win32'), false);
  assert.equal(isInside('C:\\work\\a', 'C:\\work', 'win32'), true);
});

test('win32 不区分大小写；linux 区分', () => {
  assert.equal(isInside('C:\\Work\\a', 'c:\\work', 'win32'), true);
  assert.equal(isInside('/Work/a', '/work', 'linux'), false);
});

test('敏感路径优先于其他分类', async () => {
  const { root, ctx } = await setup();
  const withRootWs = { ...ctx, workspace: root };
  assert.equal(classifyPath(ctx.paths.secrets, withRootWs), 'sensitive');
  assert.equal(classifyPath(ctx.paths.config, withRootWs), 'sensitive');
});

test('minibot.db、-wal、-shm、-journal 都是 sensitive', async () => {
  const { root, ctx } = await setup();
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    assert.equal(classifyPath(path.join(root, `minibot.db${suffix}`), ctx), 'sensitive');
  }
});

test('记忆白名单：本 bot 记忆与 user.md 为 own_memory，其他 bot 的目录为 outside', async () => {
  const { ctx } = await setup();
  assert.equal(classifyPath(ctx.paths.userMd, ctx), 'own_memory');
  assert.equal(classifyPath(path.join(ctx.paths.memoryDir('b1'), '工作.md'), ctx), 'own_memory');
  assert.equal(classifyPath(path.join(ctx.paths.memoryDir('b2'), 'x.md'), ctx), 'outside');
});

test('默认工作目录在 dataRoot 之内，仍分类为 workspace', async () => {
  const { ctx } = await setup();
  const real = await resolveReal('note.txt', ctx.paths.defaultWorkspace('b1'), ctx.home);
  assert.equal(classifyPath(real, ctx), 'workspace');
});

test('~ 展开', async () => {
  const { root, ws, ctx } = await setup();
  const real = await resolveReal('~/notes/a.txt', ws, ctx.home);
  assert.equal(real.startsWith(path.join(ctx.home, 'notes')), true);
});
