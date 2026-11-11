import type { DatabaseSync } from 'node:sqlite';
import type { ApprovalRequest, ApprovalRequestInput } from '../approval/broker.ts';
import { randomUUID } from 'node:crypto';

export type ApprovalResult = 'approved' | 'denied' | 'cancelled';
/** user：用户点的；allowlist：命中“总是允许”名单；system：中止、退出等原因自动取消 */
export type DecidedBy = 'user' | 'allowlist' | 'system';

export interface ApprovalLogEntry {
  id: number;
  requestId: string;
  botId: string;
  threadId: string;
  tool: string;
  summary: string;
  command: string | null;
  /** 仍在等待时为 null */
  result: ApprovalResult | null;
  decidedBy: DecidedBy | null;
  /** 批准时勾选了“总是允许此命令” */
  always: boolean;
  createdAt: number;
  decidedAt: number | null;
}

function rowToEntry(row: Record<string, unknown>): ApprovalLogEntry {
  return {
    id: row['id'] as number,
    requestId: row['request_id'] as string,
    botId: row['bot_id'] as string,
    threadId: row['thread_id'] as string,
    tool: row['tool'] as string,
    summary: row['summary'] as string,
    command: (row['command'] as string | null) ?? null,
    result: (row['result'] as ApprovalResult | null) ?? null,
    decidedBy: (row['decided_by'] as DecidedBy | null) ?? null,
    always: row['always'] === 1,
    createdAt: row['created_at'] as number,
    decidedAt: (row['decided_at'] as number | null) ?? null,
  };
}

export function logRequest(db: DatabaseSync, r: ApprovalRequest): void {
  db.prepare(
    `INSERT OR IGNORE INTO approval_log (request_id, bot_id, thread_id, tool, summary, command, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.id, r.botId, r.threadId, r.tool, r.summary, r.command ?? null, r.createdAt);
}

export function logResolved(db: DatabaseSync, requestId: string, result: ApprovalResult, decidedBy: DecidedBy): void {
  db.prepare(
    'UPDATE approval_log SET result = ?, decided_by = ?, decided_at = ? WHERE request_id = ? AND result IS NULL',
  ).run(result, decidedBy, Date.now(), requestId);
}

export function markAlways(db: DatabaseSync, requestId: string): void {
  db.prepare('UPDATE approval_log SET always = 1 WHERE request_id = ?').run(requestId);
}

export function logAllowlisted(db: DatabaseSync, r: ApprovalRequestInput): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO approval_log (request_id, bot_id, thread_id, tool, summary, command, result, decided_by, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, 'approved', 'allowlist', ?, ?)`,
  ).run(randomUUID(), r.botId, r.threadId, r.tool, r.summary, r.command ?? null, now, now);
}

/** 上次运行时没有结果的请求（应用异常退出）记为系统取消 */
export function closeDangling(db: DatabaseSync): void {
  db.prepare(
    "UPDATE approval_log SET result = 'cancelled', decided_by = 'system', decided_at = ? WHERE result IS NULL",
  ).run(Date.now());
}

export function listApprovalLog(
  db: DatabaseSync,
  opts: { botId?: string; before?: number; limit: number },
): ApprovalLogEntry[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.botId !== undefined) {
    where.push('bot_id = ?');
    params.push(opts.botId);
  }
  if (opts.before !== undefined) {
    where.push('id < ?');
    params.push(opts.before);
  }
  params.push(opts.limit);
  const sql = `SELECT * FROM approval_log ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => rowToEntry(row as Record<string, unknown>));
}
