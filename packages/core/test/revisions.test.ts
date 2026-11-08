import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths } from '../src/paths.ts';
import { openDb } from '../src/db/db.ts';
import { MemoryRevisions } from '../src/memory/revisions.ts';
import { sha256 } from '../src/fs/lock.ts';

async function setup(): Promise<{
  root: string;
  target: string;
  rev: MemoryRevisions;
  close(): void;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-rev-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.memoryDir('b1'), { recursive: true });
  const db = openDb(paths.db);
  const rev = new MemoryRevisions(db, paths);
  const target = path.join(paths.memoryDir('b1'), '工作.md');
  return { root, target, rev, close: () => db.close() };
}

test('首次写入：before 为磁盘原内容，after 与哈希正确', async () => {
  const { target, rev, close } = await setup();
  await fs.writeFile(target, '旧');
  const revision = await rev.write(target, '新', 'b1', 'chat');
  assert.equal(revision.beforeContent, '旧');
  assert.equal(revision.afterContent, '新');
  assert.equal(revision.afterHash, sha256('新'));
  assert.equal(revision.source, 'chat');
  assert.equal(revision.actor, 'b1');
  assert.equal(await fs.readFile(target, 'utf8'), '新');
  close();
});

test('外部修改补记（spec §9.1 第 2 步）', async () => {
  const { target, rev, close } = await setup();
  await fs.writeFile(target, '');
  await rev.write(target, 'v1', 'b1', 'chat');
  await fs.writeFile(target, 'ext');
  await rev.write(target, 'v2', 'b1', 'chat');
  const list = rev.list(target);
  assert.deepEqual(list.map((r) => r.source), ['chat', 'external', 'chat']);
  const external = list[1]!;
  assert.equal(external.actor, null);
  assert.equal(external.beforeContent, 'v1');
  assert.equal(external.afterContent, 'ext');
  assert.equal(external.afterHash, sha256('ext'));
  assert.equal(list[2]!.beforeContent, 'ext');
  close();
});

test('撤销写回 before，并记 revert，历史只增不删', async () => {
  const { target, rev, close } = await setup();
  await fs.writeFile(target, 'old');
  const r1 = await rev.write(target, 'v1', 'b1', 'chat');
  await rev.write(target, 'v2', 'b1', 'chat');
  const reverted = await rev.revert(r1.id);
  assert.equal(await fs.readFile(target, 'utf8'), 'old');
  assert.deepEqual(rev.list(target).map((r) => r.source), ['chat', 'chat', 'revert']);
  assert.equal(reverted.actor, 'user');
  assert.equal(reverted.beforeContent, 'v2');
  assert.equal(reverted.afterContent, 'old');
  close();
});

test('撤销前也补记外部修改', async () => {
  const { target, rev, close } = await setup();
  await fs.writeFile(target, 'old');
  const r1 = await rev.write(target, 'v1', 'b1', 'chat');
  await rev.write(target, 'v2', 'b1', 'chat');
  await fs.writeFile(target, 'ext');
  await rev.revert(r1.id);
  const list = rev.list(target);
  assert.deepEqual(list.map((r) => r.source), ['chat', 'chat', 'external', 'revert']);
  assert.equal(list[2]!.afterContent, 'ext');
  assert.equal(list[3]!.beforeContent, 'ext');
  assert.equal(list[3]!.afterContent, 'old');
  close();
});

test('isTracked：user.md 与本 bot 记忆为真，工作目录文件为假', async () => {
  const { root, rev, close } = await setup();
  const paths = dataPaths(root);
  assert.equal(rev.isTracked(paths.userMd), true);
  assert.equal(rev.isTracked(path.join(paths.memoryDir('b1'), 'a.md')), true);
  assert.equal(rev.isTracked(path.join(root, 'notes.md')), false);
  assert.equal(rev.isTracked(paths.botJson('b1')), false);
  close();
});
