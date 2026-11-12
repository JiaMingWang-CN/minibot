import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { gzip as gzipCallback } from 'node:zlib';
import type { DiagnosticConsent } from '../config/types.ts';
import type { DiagEvent, DiagLog } from './log.ts';

// 诊断事件的本地队列与上传。规则与中继 collect.ts 一致：
// 队列上限 1000（丢最旧）、批量 ≤ 200、积满 50 条或距上次上传 5 分钟触发、
// 失败指数退避 1 分钟 → 1 小时；400/413 视为毒丸，删除该批。
//
// 同意状态：unset 只入队不上传；off 不入队并清空队列。反馈不受开关限制。

const gzip = promisify(gzipCallback);

export const DIAG_QUEUE_MAX = 1000;
export const DIAG_BATCH_MAX = 200;
export const FEEDBACK_DESCRIPTION_MAX = 5000;
export const FEEDBACK_CONTACT_MAX = 200;

const THRESHOLD = 50;
const UPLOAD_INTERVAL_MS = 5 * 60_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const TICK_MS = 30_000;
const LOGS_WINDOW_MS = 24 * 3600_000;
const LOGS_MAX_BYTES = 1024 * 1024;

export type FeedbackFailure = 'network' | 'rate_limited' | 'unavailable' | 'rejected';

export class FeedbackError extends Error {
  readonly kind: FeedbackFailure;

  constructor(kind: FeedbackFailure, message: string) {
    super(message);
    this.name = 'FeedbackError';
    this.kind = kind;
  }
}

export interface FeedbackInput {
  description: string;
  contact?: string;
  attachLogs: boolean;
}

export interface DiagnosticUploaderOptions {
  db: DatabaseSync;
  diag: DiagLog;
  /** 收集点地址（如 https://host/collect）；null 表示整体关闭 */
  collectUrl: string | null;
  installId: () => string;
  consent: () => DiagnosticConsent;
  platform: 'win32' | 'android';
  appVersion: string;
  os: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** 是否启动定时上传；测试注入 now 时可关掉，手动调用 tick() */
  autoStart?: boolean;
  tickMs?: number;
  intervalMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  threshold?: number;
  batchSize?: number;
  queueMax?: number;
  logsWindowMs?: number;
  logsMaxBytes?: number;
}

interface QueueRow {
  id: number;
  ts: number;
  kind: string;
  name: string;
  data_json: string;
}

export class DiagnosticUploader {
  readonly available: boolean;
  private readonly db: DatabaseSync;
  private readonly diag: DiagLog;
  private readonly endpoint: string | null;
  private readonly installId: () => string;
  private readonly consent: () => DiagnosticConsent;
  private readonly platform: 'win32' | 'android';
  private readonly appVersion: string;
  private readonly os: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly autoStart: boolean;
  private readonly tickMs: number;
  private readonly intervalMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly threshold: number;
  private readonly batchSize: number;
  private readonly queueMax: number;
  private readonly logsWindowMs: number;
  private readonly logsMaxBytes: number;
  private readonly insert: StatementSync;
  private readonly count: StatementSync;
  private readonly takeRows: StatementSync;
  private readonly dropRows: StatementSync;
  private readonly trimRows: StatementSync;
  private readonly clearRows: StatementSync;
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private failures = 0;
  private nextAttemptAt = 0;
  private lastUploadAt = Number.NEGATIVE_INFINITY;
  private stopped = false;
  /** 预览过的日志：实际上传用同一份，满足“预览与上传内容一致” */
  private previewedLogs: string | null = null;

  constructor(o: DiagnosticUploaderOptions) {
    this.db = o.db;
    this.diag = o.diag;
    this.endpoint = normalizeUrl(o.collectUrl);
    this.available = this.endpoint !== null;
    this.installId = o.installId;
    this.consent = o.consent;
    this.platform = o.platform;
    this.appVersion = o.appVersion;
    this.os = o.os;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.now ?? Date.now;
    this.autoStart = o.autoStart ?? true;
    this.tickMs = o.tickMs ?? TICK_MS;
    this.intervalMs = o.intervalMs ?? UPLOAD_INTERVAL_MS;
    this.retryBaseMs = o.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = o.retryMaxMs ?? RETRY_MAX_MS;
    this.threshold = o.threshold ?? THRESHOLD;
    this.batchSize = o.batchSize ?? DIAG_BATCH_MAX;
    this.queueMax = o.queueMax ?? DIAG_QUEUE_MAX;
    this.logsWindowMs = o.logsWindowMs ?? LOGS_WINDOW_MS;
    this.logsMaxBytes = o.logsMaxBytes ?? LOGS_MAX_BYTES;
    this.insert = this.db.prepare('INSERT INTO diag_queue (ts, kind, name, data_json) VALUES (?, ?, ?, ?)');
    this.count = this.db.prepare('SELECT COUNT(*) AS n FROM diag_queue');
    this.takeRows = this.db.prepare('SELECT id, ts, kind, name, data_json FROM diag_queue ORDER BY id ASC LIMIT ?');
    this.dropRows = this.db.prepare('DELETE FROM diag_queue WHERE id <= ?');
    this.trimRows = this.db.prepare(
      'DELETE FROM diag_queue WHERE id IN (SELECT id FROM diag_queue ORDER BY id ASC LIMIT ?)',
    );
    this.clearRows = this.db.prepare('DELETE FROM diag_queue');
  }

  start(): void {
    if (this.stopped || this.unsubscribe !== null) return;
    this.unsubscribe = this.diag.onEvent((event) => this.push(event));
    if (this.autoStart) {
      this.timer = setInterval(() => void this.tick(), this.tickMs);
      this.timer.unref();
    }
  }

  close(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** 入队一条事件；off 状态或未配置收集点时直接丢弃 */
  push(event: DiagEvent & { ts?: number }): void {
    if (this.stopped || !this.available || this.consent() === 'off') return;
    try {
      // 走与日志同一条白名单：聚合指标等直接入队的事件也要过滤，避免一个怪字符连累整批
      const clean = this.diag.validateEvent(event);
      if (clean === null) return;
      try {
        this.insert.run(Math.round(event.ts ?? this.now()), clean.kind, clean.name, JSON.stringify(clean.data));
      } catch {
        this.diag.write('warn', 'diag', 'queue.write_failed');
        return;
      }
      const size = this.size();
      if (size > this.queueMax) {
        try {
          this.trimRows.run(size - this.queueMax);
        } catch {
          // 清理失败不影响新事件入队，下次再清
        }
      }
    } catch {
      // 队列写入的任何问题都不能抛给调用方
    }
  }

  size(): number {
    try {
      return Number((this.count.get() as { n?: number } | undefined)?.n ?? 0);
    } catch {
      return 0;
    }
  }

  clear(): void {
    try {
      this.clearRows.run();
    } catch {
      // 忽略
    }
  }

  setConsent(consent: DiagnosticConsent): void {
    if (consent === 'off') this.clear();
    else if (consent === 'on') void this.tick();
  }

  /** 定时器与测试共用的驱动：满足条件时上传一批 */
  async tick(): Promise<void> {
    if (this.stopped || !this.available || this.consent() !== 'on') return;
    if (this.inflight !== null) {
      await this.inflight;
      return;
    }
    const now = this.now();
    if (now < this.nextAttemptAt) return;
    if (this.size() === 0) return;
    if (this.size() < this.threshold && now - this.lastUploadAt < this.intervalMs) return;
    const run = this.flush(now).finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    await run;
  }

  /** 取最近日志（已脱敏），供反馈附件使用 */
  async recentLogs(): Promise<string> {
    return this.diag.recent(this.now() - this.logsWindowMs, this.logsMaxBytes);
  }

  /** 预览：记住这份内容，提交时若附带日志就用它，保证预览与上传一致 */
  async previewLogs(): Promise<string> {
    const text = await this.recentLogs();
    this.previewedLogs = text;
    return text;
  }

  async sendFeedback(input: FeedbackInput): Promise<void> {
    const endpoint = this.endpoint;
    if (endpoint === null) throw new FeedbackError('unavailable', '未配置收集点');
    const body: Record<string, unknown> = {
      installId: this.installId(),
      platform: this.platform,
      appVersion: this.appVersion,
      os: this.os,
      description: input.description,
    };
    if (input.contact !== undefined && input.contact.trim().length > 0) body.contact = input.contact;
    if (input.attachLogs) {
      body.logs = this.previewedLogs ?? (await this.recentLogs());
    }
    const response = await this.post(`${endpoint}/v1/feedback`, body).catch(() => null);
    if (response === null) throw new FeedbackError('network', '网络连接失败');
    if (response.ok) {
      // 成功才丢掉预览缓存；失败重试时仍是用户看过的那一份
      this.previewedLogs = null;
      return;
    }
    if (response.status === 429) throw new FeedbackError('rate_limited', '提交太频繁');
    if (response.status === 400 || response.status === 413) throw new FeedbackError('rejected', '反馈内容被拒绝');
    throw new FeedbackError('unavailable', `服务暂不可用（${response.status}）`);
  }

  // —— 内部 ——

  private async flush(now: number): Promise<void> {
    const rows = this.takeRows.all(this.batchSize) as unknown as QueueRow[];
    if (rows.length === 0) return;
    this.lastUploadAt = now;
    const lastId = rows[rows.length - 1]!.id;
    const payload = {
      installId: this.installId(),
      platform: this.platform,
      appVersion: this.appVersion,
      os: this.os,
      events: rows.map((row) => ({
        ts: row.ts,
        kind: row.kind,
        name: row.name,
        data: safeParse(row.data_json),
      })),
    };
    const response = await this.post(`${this.endpoint}/v1/events`, payload).catch(() => null);
    if (response === null) {
      this.registerFailure(now);
      this.diag.write('warn', 'diag', 'upload.failed', { reason: 'network', count: rows.length });
      return;
    }
    if (response.ok) {
      this.drop(lastId);
      this.failures = 0;
      this.nextAttemptAt = 0;
      return;
    }
    if (response.status === 400 || response.status === 413) {
      // 毒丸批次：删掉避免永远卡住队列
      this.drop(lastId);
      this.failures = 0;
      this.nextAttemptAt = 0;
      this.diag.write('warn', 'diag', 'upload.rejected', { status: response.status, count: rows.length });
      return;
    }
    this.registerFailure(now);
    this.diag.write('warn', 'diag', 'upload.failed', { status: response.status, count: rows.length });
  }

  private drop(lastId: number): void {
    try {
      this.dropRows.run(lastId);
    } catch {
      // 忽略
    }
  }

  private registerFailure(now: number): void {
    this.failures += 1;
    const delay = Math.min(this.retryBaseMs * 2 ** (this.failures - 1), this.retryMaxMs);
    this.nextAttemptAt = now + delay;
  }

  private async post(url: string, payload: unknown): Promise<Response> {
    const body = await gzip(Buffer.from(JSON.stringify(payload), 'utf8'));
    return await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: new Uint8Array(body),
    });
  }
}

function normalizeUrl(url: string | null): string | null {
  if (url === null) return null;
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed.length === 0 ? null : trimmed;
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
