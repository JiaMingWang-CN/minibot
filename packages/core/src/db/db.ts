import { DatabaseSync } from 'node:sqlite';

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
  return db;
}
