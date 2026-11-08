import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from '../src/fs/atomic-write.ts';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minibot-aw-'));
}

test('写入内容且不残留临时文件', async () => {
  const dir = await tmpDir();
  const target = path.join(dir, 'a.txt');
  await atomicWriteFile(target, 'hi');
  assert.equal(await fs.readFile(target, 'utf8'), 'hi');
  assert.deepEqual(await fs.readdir(dir), ['a.txt']);
});

test('rename 两次 EPERM 后成功', async () => {
  const dir = await tmpDir();
  const target = path.join(dir, 'b.txt');
  let calls = 0;
  const fakeRename: typeof fs.rename = async (from, to) => {
    calls += 1;
    if (calls <= 2) {
      const err = new Error('eperm') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    }
    await fs.rename(from, to);
  };
  await atomicWriteFile(target, 'ok', {
    rename: fakeRename,
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(calls, 3);
  assert.equal(await fs.readFile(target, 'utf8'), 'ok');
  assert.deepEqual(await fs.readdir(dir), ['b.txt']);
});

test('持续 EBUSY 约 2 秒后放弃并清理临时文件', async () => {
  const dir = await tmpDir();
  const target = path.join(dir, 'c.txt');
  let clock = 0;
  const fakeRename: typeof fs.rename = async () => {
    const err = new Error('ebusy') as NodeJS.ErrnoException;
    err.code = 'EBUSY';
    throw err;
  };
  await assert.rejects(
    atomicWriteFile(target, 'x', {
      rename: fakeRename,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    }),
    (err: NodeJS.ErrnoException) => {
      assert.equal(err.code, 'EBUSY');
      return true;
    },
  );
  assert.ok(clock >= 2000, `clock=${clock}`);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('ENOENT 不重试', async () => {
  const dir = await tmpDir();
  const target = path.join(dir, 'd.txt');
  let calls = 0;
  const fakeRename: typeof fs.rename = async () => {
    calls += 1;
    const err = new Error('enoent') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };
  await assert.rejects(
    atomicWriteFile(target, 'x', { rename: fakeRename, sleep: async () => {}, now: () => 0 }),
    (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
  );
  assert.equal(calls, 1);
  assert.deepEqual(await fs.readdir(dir), []);
});
