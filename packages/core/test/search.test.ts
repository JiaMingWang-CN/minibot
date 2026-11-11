import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globFiles, grepFiles } from '../src/tools/search.ts';

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minibot-search-'));
}

test('glob 跳过 .git 和 node_modules，分隔符为 /', async () => {
  const dir = await tmpRoot();
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
  await fs.mkdir(path.join(dir, '.git'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'a.ts'), 'a');
  await fs.writeFile(path.join(dir, 'node_modules', 'x', 'b.ts'), 'b');
  await fs.writeFile(path.join(dir, '.git', 'c.ts'), 'c');
  const result = await globFiles(dir, { pattern: '**/*.ts' });
  assert.equal(result.isError, false);
  assert.deepEqual(result.content.split('\n'), ['src/a.ts']);
});

test('glob 用 * 列目录', async () => {
  const dir = await tmpRoot();
  await fs.writeFile(path.join(dir, 'a.txt'), 'a');
  await fs.mkdir(path.join(dir, 'src'));
  const result = await globFiles(dir, { pattern: '*' });
  const lines = result.content.split('\n');
  assert.ok(lines.includes('a.txt'));
  assert.ok(lines.includes('src'));
});

test('glob 的模式不能用 ../ 或绝对路径越出搜索根目录', async () => {
  const outer = await tmpRoot();
  const dir = path.join(outer, 'ws');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(outer, 'secret.txt'), 's');
  await fs.writeFile(path.join(dir, 'a.txt'), 'a');
  const up = await globFiles(dir, { pattern: '../*' });
  assert.equal(up.content, '没有匹配的文件');
  const abs = await globFiles(dir, { pattern: `${outer.split(path.sep).join('/')}/*` });
  assert.equal(abs.content, '没有匹配的文件');
  const braces = await globFiles(dir, { pattern: '{..,.}/*' });
  assert.deepEqual(braces.content.split('\n'), ['a.txt']);
});

test('glob 超过 500 个截断并注明', async () => {
  const dir = await tmpRoot();
  for (let i = 0; i < 520; i += 1) {
    await fs.writeFile(path.join(dir, `f${String(i).padStart(3, '0')}.txt`), 'x');
  }
  const result = await globFiles(dir, { pattern: '*.txt' });
  const lines = result.content.split('\n');
  assert.equal(lines.length, 501);
  assert.equal(lines[lines.length - 1], '[结果超过 500 个，仅显示前 500 个]');
});

test('grep 尊重 .gitignore、跳过二进制', async () => {
  const dir = await tmpRoot();
  await fs.mkdir(path.join(dir, '.git'));
  await fs.writeFile(path.join(dir, '.gitignore'), 'ignored.txt\n');
  await fs.writeFile(path.join(dir, 'keep.txt'), 'hello\n');
  await fs.writeFile(path.join(dir, 'ignored.txt'), 'hello\n');
  await fs.writeFile(path.join(dir, 'data.bin'), Buffer.from('\u0000hello', 'binary'));
  const result = await grepFiles(dir, { pattern: 'hello' }, new AbortController().signal);
  assert.equal(result.isError, false);
  assert.ok(result.content.includes('keep.txt'));
  assert.equal(result.content.includes('ignored.txt'), false);
  assert.equal(result.content.includes('data.bin'), false);
});

test('grep 无匹配返回 "无匹配"，不是错误', async () => {
  const dir = await tmpRoot();
  await fs.writeFile(path.join(dir, 'a.txt'), 'nothing');
  const result = await grepFiles(dir, { pattern: 'zzz-not-found' }, new AbortController().signal);
  assert.equal(result.isError, false);
  assert.equal(result.content, '无匹配');
});

test('grep 超过 200 条截断并注明', async () => {
  const dir = await tmpRoot();
  for (let i = 0; i < 250; i += 1) {
    await fs.writeFile(path.join(dir, `f${String(i).padStart(3, '0')}.txt`), 'needle\n');
  }
  const result = await grepFiles(dir, { pattern: 'needle' }, new AbortController().signal);
  const lines = result.content.split('\n');
  assert.equal(lines.length, 201);
  assert.equal(lines[lines.length - 1], '[匹配超过 200 条，仅显示前 200 条]');
});
