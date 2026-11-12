import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SecretSet } from '../secrets/redact.ts';
import { redactLike, scrubPaths, type PathContext } from './scrub.ts';

export type LogLevel = 'info' | 'warn' | 'error';

export interface DiagEvent {
  kind: 'start' | 'error' | 'crash' | 'metric' | 'update';
  name: string;
  data: Record<string, string | number | boolean | null>;
}

export type TimedDiagEvent = DiagEvent & { ts: number };

export interface DiagLogOptions {
  dir: string;
  secrets: SecretSet;
  now?: () => number;
  /** 保留天数，默认 7 */
  maxDays?: number;
  /** 日志目录总量上限，默认 50 MB */
  maxBytes?: number;
  /** 路径脱敏用的上下文；不给则事件与 recent() 不做路径替换 */
  pathContext?: () => Omit<PathContext, 'workspaces'> & { workspaces?: string[] };
}

const DAY_MS = 24 * 3600_000;
const FILE_RE = /^minibot-(\d{4})-(\d{2})-(\d{2})\.log$/;
const KINDS = new Set(['start', 'error', 'crash', 'metric', 'update']);
// 与中继 collect.ts 同一规则
const EVENT_NAME = /^[a-z0-9._/-]{1,64}$/;
const DATA_KEY = /^[A-Za-z0-9._-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const STACK_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
const VALUE_MAX = 64;
const STACK_MAX = 4096;
const DATA_MAX = 4096;
const WARN_INTERVAL_MS = 60_000;
const MAX_DEPTH = 4;
const MAX_ITEMS = 100;
const BACKLOG_MAX = 50;

const pad = (n: number): string => String(n).padStart(2, '0');

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localMidnight(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

interface LogFile {
  name: string;
  /** 文件所属日期的本地零点 */
  day: number;
  size: number;
}

export class DiagLog {
  readonly secrets: SecretSet;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly maxDays: number;
  private readonly maxBytes: number;
  private readonly pathContext: DiagLogOptions['pathContext'];
  private readonly listeners = new Set<(e: TimedDiagEvent) => void>();
  private readonly workspaces = new Set<string>();
  /** 第一个订阅者出现之前发出的事件（如 app.start）先存着，订阅时补发 */
  private backlog: TimedDiagEvent[] | null = [];
  private pending: { day: string; line: string }[] = [];
  private flushScheduled = false;
  /** 所有磁盘操作串行执行 */
  private io: Promise<void> = Promise.resolve();
  private closed = false;
  private lastWarnAt = Number.NEGATIVE_INFINITY;
  private currentDay: string | null = null;
  private sinceCleanup = 0;

  constructor(o: DiagLogOptions) {
    this.dir = o.dir;
    this.secrets = o.secrets;
    this.now = o.now ?? Date.now;
    this.maxDays = o.maxDays ?? 7;
    this.maxBytes = o.maxBytes ?? 50 * 1024 * 1024;
    this.pathContext = o.pathContext;
    this.enqueue(() => this.cleanup());
  }

  /** 登记一个工作区根目录，供路径脱敏替换成 <workspace> */
  addWorkspace(dir: string): void {
    if (dir.length > 0) this.workspaces.add(dir);
  }

  /** 同步入缓冲，磁盘写入在 setImmediate 里批量完成；任何失败都不抛给调用方 */
  write(level: LogLevel, area: string, msg: string, fields?: Record<string, unknown>, event?: DiagEvent): void {
    if (this.closed) return;
    try {
      const ts = this.now();
      const row: Record<string, unknown> = { ts, level, area: this.clean(area), msg: this.clean(msg) };
      if (fields !== undefined) {
        for (const [key, value] of Object.entries(fields)) {
          if (key === 'ts' || key === 'level' || key === 'area' || key === 'msg') continue;
          const cleaned = this.sanitize(value, 0);
          if (cleaned !== undefined) row[this.clean(key)] = cleaned;
        }
      }
      this.pending.push({ day: dayKey(ts), line: `${JSON.stringify(row)}\n` });
      this.scheduleFlush();
    } catch (err) {
      this.warn(err);
    }
    if (event !== undefined) this.emitEvent(event);
  }

  /** 订阅通过白名单校验的事件；返回取消订阅函数 */
  onEvent(cb: (e: TimedDiagEvent) => void): () => void {
    const early = this.backlog;
    this.backlog = null;
    this.listeners.add(cb);
    for (const e of early ?? []) {
      try {
        cb(e);
      } catch {
        // 订阅者异常不影响日志
      }
    }
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** 取 sinceMs 之后的日志行（已做路径脱敏），总量不超过 maxBytes，保留最新的整行 */
  async recent(sinceMs: number, maxBytes: number): Promise<string> {
    await this.enqueueResult(() => this.flushNow());
    try {
      const files = (await this.listFiles()).filter((f) => f.day >= localMidnight(sinceMs)).sort((a, b) => a.day - b.day);
      const collected: string[] = [];
      for (const file of files) {
        const text = await fs.readFile(path.join(this.dir, file.name), 'utf8');
        for (const line of text.split('\n')) {
          if (line.length === 0) continue;
          try {
            const ts = (JSON.parse(line) as { ts?: unknown }).ts;
            if (typeof ts === 'number' && ts >= sinceMs) collected.push(line);
          } catch {
            // 半行或损坏的行跳过
          }
        }
      }
      const kept: string[] = [];
      let bytes = 0;
      for (let i = collected.length - 1; i >= 0; i -= 1) {
        const line = this.scrub(collected[i]!);
        const size = Buffer.byteLength(line) + 1;
        if (bytes + size > maxBytes) break;
        bytes += size;
        kept.push(line);
      }
      return kept.reverse().map((l) => `${l}\n`).join('');
    } catch {
      return '';
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.enqueue(() => this.flushNow());
    await this.io;
  }

  // —— 脱敏与校验 ——

  /** 先过已登记的密钥，再过形态过滤 */
  private clean(text: string): string {
    return redactLike(this.secrets.redact(text));
  }

  private context(): PathContext | null {
    const base = this.pathContext?.();
    if (base === undefined) return null;
    return { ...base, workspaces: [...(base.workspaces ?? []), ...this.workspaces] };
  }

  private scrub(text: string): string {
    const ctx = this.context();
    return ctx === null ? text : scrubPaths(text, ctx);
  }

  private sanitize(value: unknown, depth: number): unknown {
    if (typeof value === 'string') return this.clean(value);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (value === undefined) return undefined;
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Error) {
      return {
        name: this.clean(value.name),
        message: this.clean(value.message),
        ...(value.stack !== undefined ? { stack: this.clean(value.stack) } : {}),
      };
    }
    if (depth >= MAX_DEPTH) return '[Object]';
    if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => this.sanitize(v, depth + 1) ?? null);
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value).slice(0, MAX_ITEMS)) {
        const cleaned = this.sanitize(v, depth + 1);
        if (cleaned !== undefined) out[this.clean(k)] = cleaned;
      }
      return out;
    }
    return this.clean(String(value));
  }

  private dropped(event: string, field: string | null, reason: string): void {
    this.write('warn', 'diag', '事件字段被丢弃', { event: event.slice(0, 64), field: field?.slice(0, 64) ?? null, reason });
  }

  private emitEvent(event: DiagEvent): void {
    try {
      if (!KINDS.has(event.kind) || typeof event.name !== 'string' || !EVENT_NAME.test(event.name)) {
        this.dropped(String(event.name), null, 'name');
        return;
      }
      const data: DiagEvent['data'] = {};
      const rest: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(event.data ?? {})) {
        if (!DATA_KEY.test(key)) {
          this.dropped(event.name, key, 'key');
          continue;
        }
        if (typeof value === 'string') {
          if (key === 'stack') {
            const stack = this.clean(value);
            if (stack.length > STACK_MAX || STACK_CONTROL.test(stack)) this.dropped(event.name, key, 'stack');
            else data[key] = stack;
            continue;
          }
          const text = this.scrub(this.clean(value));
          if (text.length > VALUE_MAX || CONTROL.test(text)) this.dropped(event.name, key, 'string');
          else {
            data[key] = text;
            rest[key] = text;
          }
        } else if (typeof value === 'number') {
          if (Number.isFinite(value)) {
            data[key] = value;
            rest[key] = value;
          } else this.dropped(event.name, key, 'number');
        } else if (typeof value === 'boolean' || value === null) {
          data[key] = value;
          rest[key] = value;
        } else {
          this.dropped(event.name, key, 'type');
        }
      }
      if (JSON.stringify(rest).length > DATA_MAX) {
        this.dropped(event.name, null, 'size');
        return;
      }
      const out: TimedDiagEvent = { ts: this.now(), kind: event.kind, name: event.name, data };
      if (this.backlog !== null && this.backlog.length < BACKLOG_MAX) this.backlog.push(out);
      for (const listener of [...this.listeners]) {
        try {
          listener(out);
        } catch {
          // 订阅者异常不影响日志
        }
      }
    } catch (err) {
      this.warn(err);
    }
  }

  // —— 磁盘 ——

  private enqueue(fn: () => Promise<void>): void {
    this.io = this.io.then(fn).catch((err: unknown) => this.warn(err));
  }

  private enqueueResult(fn: () => Promise<void>): Promise<void> {
    this.enqueue(fn);
    return this.io;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.enqueue(() => this.flushNow());
    });
  }

  private warn(err: unknown): void {
    const t = this.now();
    if (t - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = t;
    console.warn(`minibot 日志写入失败：${err instanceof Error ? err.message : String(err)}`);
  }

  private async flushNow(): Promise<void> {
    const batch = this.pending;
    if (batch.length === 0) return;
    this.pending = [];
    let index = 0;
    while (index < batch.length) {
      const day = batch[index]!.day;
      let end = index;
      let text = '';
      while (end < batch.length && batch[end]!.day === day) {
        text += batch[end]!.line;
        end += 1;
      }
      index = end;
      try {
        await fs.mkdir(this.dir, { recursive: true });
        await fs.appendFile(path.join(this.dir, `minibot-${day}.log`), text, 'utf8');
      } catch (err) {
        // 目录不可写、磁盘满：丢弃这批，不影响应用
        this.warn(err);
        continue;
      }
      this.sinceCleanup += Buffer.byteLength(text);
      const switched = this.currentDay !== day;
      this.currentDay = day;
      if (switched || this.sinceCleanup >= Math.min(1024 * 1024, this.maxBytes / 4)) await this.cleanup();
    }
  }

  private async listFiles(): Promise<LogFile[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const files: LogFile[] = [];
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (m === null) continue;
      try {
        const stat = await fs.stat(path.join(this.dir, name));
        if (!stat.isFile()) continue;
        files.push({ name, day: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime(), size: stat.size });
      } catch {
        // 刚被删掉
      }
    }
    return files;
  }

  /** 先删超过保留天数的，再从最旧删起直到总量不超过上限 */
  private async cleanup(): Promise<void> {
    this.sinceCleanup = 0;
    const today = localMidnight(this.now());
    let files = await this.listFiles();
    const remove = async (file: LogFile): Promise<void> => {
      try {
        await fs.unlink(path.join(this.dir, file.name));
      } catch {
        // 已不存在或被占用，下次再清
      }
    };
    const expired = files.filter((f) => Math.round((today - f.day) / DAY_MS) >= this.maxDays);
    for (const file of expired) await remove(file);
    files = files.filter((f) => !expired.includes(f)).sort((a, b) => a.day - b.day);
    let total = files.reduce((sum, f) => sum + f.size, 0);
    for (const file of files) {
      if (total <= this.maxBytes) break;
      await remove(file);
      total -= file.size;
    }
  }
}
