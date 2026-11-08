import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths } from '../src/paths.ts';
import { openDb } from '../src/db/db.ts';
import { MemoryRevisions } from '../src/memory/revisions.ts';
import { SecretSet, REDACTED } from '../src/secrets/redact.ts';
import { ReadTracker } from '../src/tools/read-tracker.ts';
import {
  readFile,
  writeFile,
  editFile,
  ERR_STALE,
  ERR_PLACEHOLDER,
  ERR_SECRET_IN_MEMORY,
  ERR_TOPIC_PATH,
} from '../src/tools/files.ts';
import { sha256 } from '../src/fs/lock.ts';
import type { FileCtx } from '../src/tools/types.ts';

interface CtxSetup {
  root: string;
  paths: ReturnType<typeof dataPaths>;
  ctx: FileCtx;
  close(): void;
}

async function setup(): Promise<CtxSetup> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-files-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.memoryDir('b1'), { recursive: true });
  const db = openDb(paths.db);
  const revisions = new MemoryRevisions(db, paths);
  const ctx: FileCtx = {
    tracker: new ReadTracker(),
    secrets: new SecretSet(),
    revisions,
    paths,
    actor: 'b1',
  };
  return { root, paths, ctx, close: () => db.close() };
}

test('read：输出带行号，offset/limit，最多 2000 行，单行超过 2000 字符截断', async () => {
  const { root, ctx, close } = await setup();
  const file = path.join(root, 'abc.txt');
  const lines = Array.from({ length: 3000 }, (_, i) => `line${i + 1}`);
  await fs.writeFile(file, lines.join('\n'));
  const all = await readFile(ctx, file, {});
  assert.equal(all.isError, false);
  const parts = all.content.split('\n');
  assert.equal(parts[0], '1\tline1');
  assert.equal(parts[parts.length - 1], '[文件共 3000 行，已显示 1–2000 行]');
  assert.equal(parts.length, 2001);

  const window = await readFile(ctx, file, { offset: 10, limit: 5 });
  assert.equal(window.content.split('\n')[0], '10\tline10');
  assert.ok(window.content.endsWith('[文件共 3000 行，已显示 10–14 行]'));

  const longFile = path.join(root, 'long.txt');
  await fs.writeFile(longFile, 'x'.repeat(5000));
  const longRead = await readFile(ctx, longFile, {});
  assert.ok(longRead.content.includes('…[本行已截断]'));
  assert.ok(longRead.content.length < 5000);
  close();
});

test('read：UTF-16 文件（BOM FF FE / FE FF）给出专门提示', async () => {
  const { root, ctx, close } = await setup();
  for (const [name, head] of [
    ['le.txt', [0xff, 0xfe]],
    ['be.txt', [0xfe, 0xff]],
  ] as const) {
    const file = path.join(root, name);
    await fs.writeFile(file, Buffer.from([...head, 0x41, 0x00]));
    const result = await readFile(ctx, file, {});
    assert.equal(result.isError, true);
    assert.ok(result.content.includes('UTF-16 编码，暂不支持'));
    assert.equal(result.content.includes('二进制'), false);
  }
  close();
});

test('read：拒绝二进制（前 8KB 有 NUL）', async () => {
  const { root, ctx, close } = await setup();
  const file = path.join(root, 'bin.dat');
  await fs.writeFile(file, Buffer.from('abc\u0000def', 'binary'));
  const result = await readFile(ctx, file, {});
  assert.equal(result.isError, true);
  assert.ok(result.content.includes('二进制'));
  close();
});

test('read：非 UTF-8 文本（GBK）给出明确错误', async () => {
  const { root, ctx, close } = await setup();
  const file = path.join(root, 'gbk.txt');
  await fs.writeFile(file, Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
  const result = await readFile(ctx, file, {});
  assert.equal(result.isError, true);
  assert.ok(result.content.includes('不是 UTF-8'));
  close();
});

test('write：覆盖未读过的已有文件 → ERR_STALE；新建不受限', async () => {
  const { root, ctx, close } = await setup();
  const file = path.join(root, 'w.txt');
  await fs.writeFile(file, 'old');
  const stale = await writeFile(ctx, file, { content: 'new' });
  assert.equal(stale.isError, true);
  assert.equal(stale.content, ERR_STALE);
  assert.equal(await fs.readFile(file, 'utf8'), 'old');

  const fresh = path.join(root, 'fresh.txt');
  const created = await writeFile(ctx, fresh, { content: 'hello' });
  assert.equal(created.isError, false);
  assert.equal(await fs.readFile(fresh, 'utf8'), 'hello');
  close();
});

test('write：读后被外部改动 → ERR_STALE；写成功后可以连续再写', async () => {
  const { root, ctx, close } = await setup();
  const file = path.join(root, 'w2.txt');
  await fs.writeFile(file, 'a');
  await readFile(ctx, file, {});
  await fs.writeFile(file, 'b');
  const stale = await writeFile(ctx, file, { content: 'c' });
  assert.equal(stale.content, ERR_STALE);
  assert.equal(await fs.readFile(file, 'utf8'), 'b');

  await readFile(ctx, file, {});
  assert.equal((await writeFile(ctx, file, { content: 'd' })).isError, false);
  assert.equal((await writeFile(ctx, file, { content: 'e' })).isError, false);
  assert.equal(await fs.readFile(file, 'utf8'), 'e');
  close();
});

test('edit：0 处匹配报错；多处匹配且未设 replace_all 报错并给出数量；replace_all 全部替换', async () => {
  const { root, ctx, close } = await setup();
  const file = path.join(root, 'e.txt');
  await writeFile(ctx, file, { content: 'abc abc abc' });
  const zero = await editFile(ctx, file, { old_string: 'zzz', new_string: 'x' });
  assert.equal(zero.isError, true);
  const multi = await editFile(ctx, file, { old_string: 'abc', new_string: 'x' });
  assert.equal(multi.isError, true);
  assert.ok(multi.content.includes('3'));
  const all = await editFile(ctx, file, { old_string: 'abc', new_string: 'x', replace_all: true });
  assert.equal(all.isError, false);
  assert.equal(await fs.readFile(file, 'utf8'), 'x x x');
  close();
});

test('edit：CRLF 文件 + LF 的 old_string 能替换且保留 CRLF（Review Focus 2）', async () => {
  const { root, ctx, close } = await setup();
  const file = path.join(root, 'crlf.txt');
  await writeFile(ctx, file, { content: 'a\r\nb\r\nc\r\n' });
  const result = await editFile(ctx, file, { old_string: 'a\nb', new_string: 'x\ny' });
  assert.equal(result.isError, false);
  assert.equal(await fs.readFile(file, 'utf8'), 'x\r\ny\r\nc\r\n');
  close();
});

test('占位符回写被拒（write 内容、edit 的 old/new）', async () => {
  const { root, ctx, close } = await setup();
  const file = path.join(root, 'p.txt');
  await fs.writeFile(file, 'safe');
  await readFile(ctx, file, {});
  const byWrite = await writeFile(ctx, file, { content: `x ${REDACTED}` });
  assert.equal(byWrite.content, ERR_PLACEHOLDER);
  const editNew = await editFile(ctx, file, { old_string: 'safe', new_string: REDACTED });
  assert.equal(editNew.content, ERR_PLACEHOLDER);
  const editOld = await editFile(ctx, file, { old_string: `safe ${REDACTED}`, new_string: 'x' });
  assert.equal(editOld.content, ERR_PLACEHOLDER);
  assert.equal(await fs.readFile(file, 'utf8'), 'safe');
  close();
});

test('写记忆含已知 Key → ERR_SECRET_IN_MEMORY；写普通文件含 Key → 原样写入', async () => {
  const { root, paths, ctx, close } = await setup();
  ctx.secrets.add('sk-12345678');
  const memoryFile = path.join(paths.memoryDir('b1'), '工作.md');
  const memoryResult = await writeFile(ctx, memoryFile, { content: 'key sk-12345678' });
  assert.equal(memoryResult.content, ERR_SECRET_IN_MEMORY);
  assert.equal(await fs.access(memoryFile).then(() => true, () => false), false);

  const normal = path.join(root, 'normal.txt');
  const normalResult = await writeFile(ctx, normal, { content: 'key sk-12345678' });
  assert.equal(normalResult.isError, false);
  assert.equal(await fs.readFile(normal, 'utf8'), 'key sk-12345678');
  close();
});

test('写记忆走修订：生成 source "chat"、actor 为 bot id 的修订', async () => {
  const { paths, ctx, close } = await setup();
  const memoryFile = path.join(paths.memoryDir('b1'), '项目.md');
  const result = await writeFile(ctx, memoryFile, { content: '> 简介：项目\n正文' });
  assert.equal(result.isError, false);
  const list = ctx.revisions.list(memoryFile);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.source, 'chat');
  assert.equal(list[0]!.actor, 'b1');
  close();
});

test('记忆嵌套路径 → ERR_TOPIC_PATH，且没有建出子目录（Review Focus 5）', async () => {
  const { paths, ctx, close } = await setup();
  const nested = path.join(paths.memoryDir('b1'), 'C++', 'Rust.md');
  const result = await writeFile(ctx, nested, { content: '> 简介：Rust\nx' });
  assert.equal(result.content, ERR_TOPIC_PATH);
  assert.deepEqual(await fs.readdir(paths.memoryDir('b1')), []);
  const colon = path.join(paths.memoryDir('b1'), 'a:b.md');
  assert.equal((await writeFile(ctx, colon, { content: 'x' })).content, ERR_TOPIC_PATH);
  close();
});
