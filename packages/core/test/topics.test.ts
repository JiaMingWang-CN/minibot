import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TOPIC_HEADER_RE,
  parseTopicHeader,
  isValidTopicFile,
  buildTopicIndex,
} from '../src/memory/topics.ts';

test('首行解析兼容 BOM、CRLF、全半角冒号、无空格、全角空格', () => {
  for (const line of [
    '> 简介：项目A',
    '> 简介: 项目A',
    '\uFEFF> 简介：项目A',
    '> 简介：项目A\r',
    '>简介:项目A',
    '> 简介：　项目A',
  ]) {
    assert.equal(parseTopicHeader(line), '项目A');
  }
  assert.equal(parseTopicHeader('> 简介：项目A   '), '项目A');
  assert.equal(parseTopicHeader('> 简介：'), null);
  assert.equal(parseTopicHeader('简介：项目A'), null);
  assert.equal(parseTopicHeader('> 简介：   '), null);
  assert.equal(TOPIC_HEADER_RE.test('> 简介：项目A'), true);
});

test('目录：缺简介的列为 null，忽略子目录与非 .md', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-topics-'));
  await fs.writeFile(path.join(dir, 'a.md'), '> 简介：项目A\n正文');
  await fs.writeFile(path.join(dir, 'b.md'), '没有简介\n正文');
  await fs.mkdir(path.join(dir, 'child'));
  await fs.writeFile(path.join(dir, 'child', 'c.md'), '> 简介：子\n');
  await fs.writeFile(path.join(dir, 'note.txt'), 'x');
  const topics = await buildTopicIndex(dir);
  assert.deepEqual(topics.map((t) => t.name), ['a', 'b']);
  assert.equal(topics[0]!.summary, '项目A');
  assert.equal(topics[1]!.summary, null);
  assert.equal(topics[0]!.path, path.join(dir, 'a.md'));
});

test('目录不存在时返回空数组', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-topics-'));
  assert.deepEqual(await buildTopicIndex(path.join(dir, 'missing')), []);
});

test('isValidTopicFile 拒绝嵌套与非法名', () => {
  const memoryDir = path.join(os.tmpdir(), 'minibot-memory-dir');
  assert.equal(isValidTopicFile(path.join(memoryDir, 'C++', 'Rust.md'), memoryDir), false);
  assert.equal(isValidTopicFile(path.join(memoryDir, 'a:b.md'), memoryDir), false);
  assert.equal(isValidTopicFile(path.join(memoryDir, '工作.md'), memoryDir), true);
  assert.equal(isValidTopicFile(memoryDir, memoryDir), false);
  assert.equal(isValidTopicFile(path.join(memoryDir, 'noext'), memoryDir), false);
});
