import type { DatabaseSync } from 'node:sqlite';
import type { Block, MessageKind, StoredMessage } from '../model/types.ts';

export const CANCELLED_TEXT = '工具调用已取消（用户中断或应用退出）';

function rowToMessage(row: Record<string, unknown>): StoredMessage {
  return {
    id: row['id'] as number,
    threadId: row['thread_id'] as string,
    role: row['role'] as 'user' | 'assistant',
    blocks: JSON.parse(row['blocks'] as string) as Block[],
    kind: row['kind'] === null ? null : (row['kind'] as MessageKind),
    interrupted: row['interrupted'] === 1,
    createdAt: row['created_at'] as number,
  };
}

export function appendMessage(
  db: DatabaseSync,
  m: Omit<StoredMessage, 'id' | 'createdAt'>,
): StoredMessage {
  const createdAt = Date.now();
  const result = db
    .prepare(
      `INSERT INTO messages (thread_id, role, blocks, kind, interrupted, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(m.threadId, m.role, JSON.stringify(m.blocks), m.kind, m.interrupted ? 1 : 0, createdAt);
  return { ...m, id: Number(result.lastInsertRowid), createdAt };
}

export interface ListMessagesOptions {
  before?: number;
  limit: number;
}

export function listMessages(
  db: DatabaseSync,
  threadId: string,
  opts: ListMessagesOptions,
): StoredMessage[] {
  const rows =
    opts.before === undefined
      ? db
          .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?')
          .all(threadId, opts.limit)
      : db
          .prepare('SELECT * FROM messages WHERE thread_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
          .all(threadId, opts.before, opts.limit);
  return rows.map((row) => rowToMessage(row as Record<string, unknown>)).reverse();
}

export function messagesFrom(db: DatabaseSync, threadId: string, fromId: number): StoredMessage[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE thread_id = ? AND id >= ? ORDER BY id ASC')
    .all(threadId, fromId);
  return rows.map((row) => rowToMessage(row as Record<string, unknown>));
}

export function getMessage(db: DatabaseSync, id: number): StoredMessage | null {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  return row === undefined ? null : rowToMessage(row as Record<string, unknown>);
}

export function repairDanglingToolUses(db: DatabaseSync): number {
  const threadRows = db.prepare('SELECT id FROM threads').all();
  let repaired = 0;
  for (const threadRow of threadRows) {
    const threadId = (threadRow as Record<string, unknown>)['id'] as string;
    const messages = messagesFrom(db, threadId, 0);
    const pending = new Set<string>();
    for (const message of messages) {
      if (message.role === 'assistant') {
        for (const block of message.blocks) {
          if (block.type === 'tool_use') pending.add(block.id);
        }
      } else {
        for (const block of message.blocks) {
          if (block.type === 'tool_result') pending.delete(block.toolUseId);
        }
      }
    }
    if (pending.size === 0) continue;
    const blocks: Block[] = [...pending].map((id) => ({
      type: 'tool_result',
      toolUseId: id,
      content: CANCELLED_TEXT,
      status: 'cancelled',
    }));
    appendMessage(db, { threadId, role: 'user', blocks, kind: null, interrupted: false });
    repaired += blocks.length;
  }
  return repaired;
}
