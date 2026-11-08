import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { atomicWriteFile } from '../fs/atomic-write.ts';
import { sha256, withPathLock } from '../fs/lock.ts';
import type { DataPaths } from '../paths.ts';
import { isInside } from '../tools/path-guard.ts';

export type RevisionSource = 'chat' | 'consolidation' | 'manual_ui' | 'revert' | 'external';

export interface Revision {
  id: number;
  filePath: string;
  actor: string | null;
  source: RevisionSource;
  createdAt: number;
  beforeContent: string;
  afterContent: string;
  afterHash: string;
}

function rowToRevision(row: Record<string, unknown>): Revision {
  return {
    id: row['id'] as number,
    filePath: row['file_path'] as string,
    actor: row['actor'] === null ? null : (row['actor'] as string),
    source: row['source'] as RevisionSource,
    createdAt: row['created_at'] as number,
    beforeContent: row['before_content'] as string,
    afterContent: row['after_content'] as string,
    afterHash: row['after_hash'] as string,
  };
}

async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

export class MemoryRevisions {
  private db: DatabaseSync;
  private paths: DataPaths;

  constructor(db: DatabaseSync, paths: DataPaths) {
    this.db = db;
    this.paths = paths;
  }

  isTracked(real: string): boolean {
    if (isInside(real, this.paths.userMd)) return true;
    const rel = path.relative(this.paths.botsDir, real);
    if (path.isAbsolute(rel) || rel.startsWith('..')) return false;
    const parts = rel.split(path.sep);
    return parts.length >= 3 && parts[1] === 'memory';
  }

  list(real: string): Revision[] {
    const rows = this.db
      .prepare('SELECT * FROM memory_revisions WHERE file_path = ? ORDER BY id ASC')
      .all(real);
    return rows.map((row) => rowToRevision(row as Record<string, unknown>));
  }

  async write(
    real: string,
    content: string,
    actor: string,
    source: Exclude<RevisionSource, 'external'>,
  ): Promise<Revision> {
    const disk = await readText(real);
    const currentHash = sha256(disk);
    const last = this.lastRevision(real);
    if (last !== null && currentHash !== last.afterHash) {
      this.insert(real, null, 'external', last.afterContent, disk, currentHash);
    }
    await atomicWriteFile(real, content);
    const hash = sha256(content);
    return this.insert(real, actor, source, disk, content, hash);
  }

  async revert(revisionId: number): Promise<Revision> {
    const row = this.db.prepare('SELECT * FROM memory_revisions WHERE id = ?').get(revisionId);
    if (row === undefined) throw new Error(`修订 ${revisionId} 不存在`);
    const revision = rowToRevision(row as Record<string, unknown>);
    return withPathLock(revision.filePath, () =>
      this.write(revision.filePath, revision.beforeContent, 'user', 'revert'),
    );
  }

  private lastRevision(real: string): Revision | null {
    const row = this.db
      .prepare('SELECT * FROM memory_revisions WHERE file_path = ? ORDER BY id DESC LIMIT 1')
      .get(real);
    return row === undefined ? null : rowToRevision(row as Record<string, unknown>);
  }

  private insert(
    real: string,
    actor: string | null,
    source: RevisionSource,
    beforeContent: string,
    afterContent: string,
    afterHash: string,
  ): Revision {
    const createdAt = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO memory_revisions
         (file_path, actor, source, created_at, before_content, after_content, after_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(real, actor, source, createdAt, beforeContent, afterContent, afterHash);
    return {
      id: Number(result.lastInsertRowid),
      filePath: real,
      actor,
      source,
      createdAt,
      beforeContent,
      afterContent,
      afterHash,
    };
  }
}
