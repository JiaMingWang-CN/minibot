import type { DatabaseSync } from 'node:sqlite';
import type { Block, MessageKind, StoredMessage, Usage } from '../model/types.ts';
import { searchableText } from './db.ts';

export const CANCELLED_TEXT = '工具调用已取消（用户中断或应用退出）';

function rowToMessage(row: Record<string, unknown>): StoredMessage {
  const message: StoredMessage = {
    id: row['id'] as number,
    threadId: row['thread_id'] as string,
    role: row['role'] as 'user' | 'assistant',
    blocks: JSON.parse(row['blocks'] as string) as Block[],
    kind: row['kind'] === null ? null : (row['kind'] as MessageKind),
    interrupted: row['interrupted'] === 1,
    createdAt: row['created_at'] as number,
  };
  if (row['input_tokens'] !== null && row['input_tokens'] !== undefined) {
    const usage: Usage = {
      inputTokens: row['input_tokens'] as number,
      outputTokens: (row['output_tokens'] as number | null) ?? 0,
    };
    if (row['cached_tokens'] !== null) usage.cachedInputTokens = row['cached_tokens'] as number;
    message.usage = usage;
  }
  return message;
}

export function appendMessage(
  db: DatabaseSync,
  m: Omit<StoredMessage, 'id' | 'createdAt'>,
): StoredMessage {
  const createdAt = Date.now();
  const blocks = JSON.stringify(m.blocks);
  const result = db
    .prepare(
      `INSERT INTO messages (thread_id, role, blocks, kind, interrupted, created_at, input_tokens, output_tokens, cached_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.threadId,
      m.role,
      blocks,
      m.kind,
      m.interrupted ? 1 : 0,
      createdAt,
      m.usage?.inputTokens ?? null,
      m.usage?.outputTokens ?? null,
      m.usage?.cachedInputTokens ?? null,
    );
  const id = Number(result.lastInsertRowid);
  const text = searchableText(m.kind, blocks);
  if (text.length > 0) {
    db.prepare('INSERT INTO messages_fts (text, thread_id, message_id) VALUES (?, ?, ?)').run(text, m.threadId, id);
  }
  const stored: StoredMessage = { ...m, id, createdAt };
  if (stored.usage === undefined) delete stored.usage;
  return stored;
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

/** 删除线程中 id >= fromId 的消息（含索引），返回被删的消息 */
export function deleteMessagesFrom(db: DatabaseSync, threadId: string, fromId: number): StoredMessage[] {
  const removed = messagesFrom(db, threadId, fromId);
  db.prepare('DELETE FROM messages_fts WHERE thread_id = ? AND message_id >= ?').run(threadId, fromId);
  db.prepare('DELETE FROM messages WHERE thread_id = ? AND id >= ?').run(threadId, fromId);
  return removed;
}

export interface ThreadUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** 有任何一次调用没报告缓存命中时为 null */
  cachedInputTokens: number | null;
}

export function threadUsage(db: DatabaseSync, threadId: string): ThreadUsage {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0) AS input,
              COALESCE(SUM(output_tokens), 0) AS output,
              COALESCE(SUM(cached_tokens), 0) AS cached,
              SUM(CASE WHEN cached_tokens IS NULL THEN 1 ELSE 0 END) AS unknown
       FROM messages WHERE thread_id = ? AND input_tokens IS NOT NULL`,
    )
    .get(threadId) as Record<string, number>;
  return {
    calls: row['calls']!,
    inputTokens: row['input']!,
    outputTokens: row['output']!,
    cachedInputTokens: row['calls']! > 0 && row['unknown']! === 0 ? row['cached']! : null,
  };
}

export interface SearchHit {
  messageId: number;
  threadId: string;
  threadTitle: string;
  botId: string;
  role: 'user' | 'assistant';
  snippet: string;
  createdAt: number;
}

function snippetOf(text: string, query: string): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, (index === -1 ? 0 : index) - 30);
  const end = Math.min(text.length, (index === -1 ? 0 : index) + query.length + 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function searchMessages(
  db: DatabaseSync,
  query: string,
  opts: { botId?: string; limit: number },
): SearchHit[] {
  // trigram 至少需要 3 个字符；更短的查询（如两个字的中文词）走 LIKE 全表扫描
  const useMatch = [...query].length >= 3;
  const where = useMatch ? 'messages_fts MATCH ?' : "f.text LIKE ? ESCAPE '\\'";
  const term = useMatch
    ? `"${query.replace(/"/g, '""')}"`
    : `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const params: (string | number)[] = [term];
  let botFilter = '';
  if (opts.botId !== undefined) {
    botFilter = 'AND t.bot_id = ?';
    params.push(opts.botId);
  }
  params.push(opts.limit);
  const rows = db
    .prepare(
      `SELECT f.text AS text, m.id AS id, m.thread_id AS thread_id, m.role AS role, m.created_at AS created_at,
              t.title AS title, t.bot_id AS bot_id
       FROM messages_fts f
       JOIN messages m ON m.id = f.message_id
       JOIN threads t ON t.id = m.thread_id
       WHERE ${where} ${botFilter}
       ORDER BY m.id DESC LIMIT ?`,
    )
    .all(...params);
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      messageId: r['id'] as number,
      threadId: r['thread_id'] as string,
      threadTitle: r['title'] as string,
      botId: r['bot_id'] as string,
      role: r['role'] as 'user' | 'assistant',
      snippet: snippetOf(r['text'] as string, query),
      createdAt: r['created_at'] as number,
    };
  });
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
