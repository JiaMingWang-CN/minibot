import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/db.ts';
import { createThread, getThread, listThreads, updateThread } from '../src/db/threads.ts';
import {
  appendMessage,
  listMessages,
  messagesFrom,
  getMessage,
  repairDanglingToolUses,
  CANCELLED_TEXT,
} from '../src/db/messages.ts';
import type { Block } from '../src/model/types.ts';

async function tmpDbPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-db-'));
  return path.join(dir, 'minibot.db');
}

test('WAL 已开启', async () => {
  const db = openDb(await tmpDbPath());
  const row = db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>;
  assert.equal(row['journal_mode'], 'wal');
  db.close();
});

test('分页：before + limit，结果升序', async () => {
  const db = openDb(await tmpDbPath());
  const thread = createThread(db, 'b1', 't');
  const ids: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    ids.push(appendMessage(db, { threadId: thread.id, role: 'user', blocks: [{ type: 'text', text: String(i) }], kind: null, interrupted: false }).id);
  }
  const page = listMessages(db, thread.id, { before: ids[4]!, limit: 2 });
  assert.deepEqual(page.map((m) => m.id), [ids[2], ids[3]]);
  db.close();
});

test('blocks 以 JSON 往返', async () => {
  const db = openDb(await tmpDbPath());
  const thread = createThread(db, 'b1', 't');
  const blocks: Block[] = [
    { type: 'tool_use', id: 'tu_A', name: 'read_file', input: { path: 'a', meta: { x: [1, 2] } } },
  ];
  const stored = appendMessage(db, { threadId: thread.id, role: 'assistant', blocks, kind: null, interrupted: false });
  const read = getMessage(db, stored.id);
  assert.deepEqual(read?.blocks, blocks);
  db.close();
});

test('悬空 tool_use 补 cancelled 结果（Review Focus 1）', async () => {
  const db = openDb(await tmpDbPath());
  const thread = createThread(db, 'b1', 't');
  appendMessage(db, {
    threadId: thread.id,
    role: 'assistant',
    blocks: [
      { type: 'tool_use', id: 'a', name: 'read_file', input: {} },
      { type: 'tool_use', id: 'b', name: 'read_file', input: {} },
    ],
    kind: null,
    interrupted: true,
  });
  appendMessage(db, {
    threadId: thread.id,
    role: 'user',
    blocks: [{ type: 'tool_result', toolUseId: 'a', content: 'ok', status: 'ok' }],
    kind: null,
    interrupted: false,
  });
  assert.equal(repairDanglingToolUses(db), 1);
  const all = messagesFrom(db, thread.id, 0);
  const last = all[all.length - 1]!;
  assert.equal(last.role, 'user');
  assert.deepEqual(last.blocks, [
    { type: 'tool_result', toolUseId: 'b', content: CANCELLED_TEXT, status: 'cancelled' },
  ]);
  db.close();
});

test('没有悬空时不改动', async () => {
  const db = openDb(await tmpDbPath());
  const thread = createThread(db, 'b1', 't');
  appendMessage(db, { threadId: thread.id, role: 'user', blocks: [{ type: 'text', text: 'hi' }], kind: null, interrupted: false });
  assert.equal(repairDanglingToolUses(db), 0);
  assert.equal(messagesFrom(db, thread.id, 0).length, 1);
  db.close();
});

test('memory_revisions 拒绝非法 source', async () => {
  const db = openDb(await tmpDbPath());
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO memory_revisions (file_path, actor, source, created_at, before_content, after_content, after_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('f', null, 'foo', 1, '', '', 'h'),
  );
  db.close();
});

test('线程按 last_activity_at 倒序', async () => {
  const db = openDb(await tmpDbPath());
  const a = createThread(db, 'b1', 'a');
  const b = createThread(db, 'b1', 'b');
  updateThread(db, a.id, { lastActivityAt: 2 });
  updateThread(db, b.id, { lastActivityAt: 1 });
  assert.deepEqual(listThreads(db, 'b1').map((t) => t.id), [a.id, b.id]);
  assert.equal(getThread(db, a.id)?.title, 'a');
  db.close();
});

test('updateThread 只更新给定字段', async () => {
  const db = openDb(await tmpDbPath());
  const t = createThread(db, 'b1', 'x');
  updateThread(db, t.id, { title: 'y', summaryMsgId: 7, lastInputTokens: 100 });
  const got = getThread(db, t.id)!;
  assert.equal(got.title, 'y');
  assert.equal(got.summaryMsgId, 7);
  assert.equal(got.lastInputTokens, 100);
  assert.equal(got.lastExtractedMsgId, 0);
  db.close();
});
