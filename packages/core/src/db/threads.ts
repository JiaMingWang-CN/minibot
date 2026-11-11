import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface Thread {
  id: string;
  botId: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  lastExtractedMsgId: number;
  summaryMsgId: number | null;
  keepFromMsgId: number;
  lastInputTokens: number | null;
  lastInputMsgId: number | null;
}

export type ThreadPatch = Partial<
  Pick<
    Thread,
    | 'title'
    | 'lastActivityAt'
    | 'lastExtractedMsgId'
    | 'summaryMsgId'
    | 'keepFromMsgId'
    | 'lastInputTokens'
    | 'lastInputMsgId'
  >
>;

function rowToThread(row: Record<string, unknown>): Thread {
  return {
    id: row['id'] as string,
    botId: row['bot_id'] as string,
    title: row['title'] as string,
    createdAt: row['created_at'] as number,
    lastActivityAt: row['last_activity_at'] as number,
    lastExtractedMsgId: row['last_extracted_msg_id'] as number,
    summaryMsgId: row['summary_msg_id'] === null ? null : (row['summary_msg_id'] as number),
    keepFromMsgId: row['keep_from_msg_id'] as number,
    lastInputTokens: row['last_input_tokens'] === null ? null : (row['last_input_tokens'] as number),
    lastInputMsgId: row['last_input_msg_id'] === null ? null : (row['last_input_msg_id'] as number),
  };
}

export function createThread(db: DatabaseSync, botId: string, title: string): Thread {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO threads (id, bot_id, title, created_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, botId, title, now, now);
  const thread = getThread(db, id);
  if (thread === null) throw new Error('创建线程失败');
  return thread;
}

export function getThread(db: DatabaseSync, id: string): Thread | null {
  const row = db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
  return row === undefined ? null : rowToThread(row as Record<string, unknown>);
}

export function listThreads(db: DatabaseSync, botId: string): Thread[] {
  const rows = db
    .prepare('SELECT * FROM threads WHERE bot_id = ? ORDER BY last_activity_at DESC, created_at DESC')
    .all(botId);
  return rows.map((row) => rowToThread(row as Record<string, unknown>));
}

const PATCH_COLUMNS: Record<keyof ThreadPatch, string> = {
  title: 'title',
  lastActivityAt: 'last_activity_at',
  lastExtractedMsgId: 'last_extracted_msg_id',
  summaryMsgId: 'summary_msg_id',
  keepFromMsgId: 'keep_from_msg_id',
  lastInputTokens: 'last_input_tokens',
  lastInputMsgId: 'last_input_msg_id',
};

export function updateThread(db: DatabaseSync, id: string, patch: ThreadPatch): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof ThreadPatch, string][]) {
    if (!(key in patch)) continue;
    const value = patch[key];
    sets.push(`${column} = ?`);
    values.push(value === undefined ? null : value);
  }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteThreadRow(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM threads WHERE id = ?').run(id);
}
