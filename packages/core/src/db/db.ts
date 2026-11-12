import { DatabaseSync } from 'node:sqlite';

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => (row as Record<string, unknown>)['name'] === column);
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name) !== undefined;
}

/**
 * 在事务里执行 fn：抛错就回滚。DatabaseSync 不支持嵌套 BEGIN，
 * 已经在事务中（调用方外层包了事务）就直接执行，由外层统一提交 / 回滚。
 */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { timeout: 5000 });
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      last_extracted_msg_id INTEGER NOT NULL DEFAULT 0,
      summary_msg_id INTEGER NULL,
      keep_from_msg_id INTEGER NOT NULL DEFAULT 0,
      last_input_tokens INTEGER NULL,
      last_input_msg_id INTEGER NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      blocks TEXT NOT NULL,
      kind TEXT NULL,
      interrupted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id, id)');
  // 用量：只记在由模型调用产生的 assistant 消息上；cached_tokens 为 NULL 表示供应商没报告
  for (const column of ['input_tokens', 'output_tokens', 'cached_tokens']) {
    if (!hasColumn(db, 'messages', column)) db.exec(`ALTER TABLE messages ADD COLUMN ${column} INTEGER NULL`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      actor TEXT NULL,
      source TEXT NOT NULL CHECK(source IN ('chat','consolidation','manual_ui','revert','external')),
      created_at INTEGER NOT NULL,
      before_content TEXT NOT NULL,
      after_content TEXT NOT NULL,
      after_hash TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_revisions_file ON memory_revisions(file_path, id)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      bot_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      summary TEXT NOT NULL,
      command TEXT NULL,
      result TEXT NULL CHECK(result IN ('approved','denied','cancelled')),
      decided_by TEXT NULL CHECK(decided_by IN ('user','allowlist','system')),
      always INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      decided_at INTEGER NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_approval_log_bot ON approval_log(bot_id, id)');
  // 消息全文索引：trigram 分词按子串匹配，中文不需要分词；少于 3 个字的查询改用 LIKE
  if (!hasTable(db, 'messages_fts')) {
    db.exec(
      "CREATE VIRTUAL TABLE messages_fts USING fts5(text, thread_id UNINDEXED, message_id UNINDEXED, tokenize='trigram')",
    );
    backfillSearchIndex(db);
  }
  return db;
}

/** 可搜索的文字：只收普通对话消息（不含通知与摘要）里的文本块 */
export function searchableText(kind: string | null, blocksJson: string): string {
  if (kind !== null) return '';
  const blocks = JSON.parse(blocksJson) as { type: string; text?: string }[];
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

function backfillSearchIndex(db: DatabaseSync): void {
  const insert = db.prepare('INSERT INTO messages_fts (text, thread_id, message_id) VALUES (?, ?, ?)');
  for (const row of db.prepare('SELECT id, thread_id, kind, blocks FROM messages').all()) {
    const r = row as Record<string, unknown>;
    const text = searchableText(r['kind'] as string | null, r['blocks'] as string);
    if (text.length > 0) insert.run(text, r['thread_id'] as string, r['id'] as number);
  }
}
