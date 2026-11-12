import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { gunzip } from 'node:zlib';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

// 诊断收集（可选）：只收白名单事件与用户主动提交的反馈。
// 本模块任何错误都只影响收集请求本身（返回 4xx/5xx），不得波及中继转发；日志只记计数与错误。

const SCHEMA_VERSION = 1;
const EVENTS_MAX_RAW = 256 * 1024;
const EVENTS_MAX_INFLATED = 1024 * 1024;
const EVENTS_MAX_COUNT = 200;
const FEEDBACK_MAX_RAW = 2 * 1024 * 1024;
const FEEDBACK_MAX_INFLATED = 8 * 1024 * 1024;
const DESCRIPTION_MAX = 5000;
const CONTACT_MAX = 200;
const EVENT_DATA_MAX = 4096;
const STACK_MAX = 4096;
const EVENT_DATA_STRING_MAX = 64;
const WRITE_CAP_BYTES = 20 * 1024 * 1024;
const BODY_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT = 64;
const WINDOW_MS = 60_000;
const EVENTS_PER_MINUTE = 30;
const FEEDBACK_PER_MINUTE = 3;
const FEEDBACK_PER_INSTALL_PER_DAY = 20;
const DAY_MS = 24 * 3600_000;
const SWEEP_INTERVAL_MS = 60_000;
const DRAIN_MAX_BYTES = 16 * 1024 * 1024;
const DRAIN_TIMEOUT_MS = 5000;

const PLATFORMS = new Set(['win32', 'android']);
const KINDS = new Set(['start', 'error', 'crash', 'metric', 'update']);

export interface CollectorOptions {
  dbPath: string;
  maxBytes: number;
  now: () => number;
  log: (message: string) => void;
}

export interface Collector {
  handle(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void>;
  close(): void;
}

/** 带状态码的处理失败：用于校验与限额，区别于未预期的内部错误（500） */
class Reject extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`reject ${status}`);
    this.status = status;
  }
}

interface Statements {
  db: DatabaseSync;
  insertEvent: StatementSync;
  insertFeedback: StatementSync;
}

interface Common {
  installId: string;
  platform: string;
  appVersion: string;
  os: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 控制字符（C0/C1/DEL）不允许出现在元数据字段里
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const DESCRIPTION_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const EVENT_NAME = /^[a-z0-9._/-]{1,64}$/;
const DATA_KEY = /^[A-Za-z0-9._-]{1,64}$/;

/** 非空、长度受限、无控制字符的短字符串 */
function shortString(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || CONTROL.test(value)) throw new Reject(400);
  return value;
}

/** 事件 data：扁平对象，值只能是 string(≤64)/有限 number/boolean/null；唯一例外是 stack（≤4096 字、允许换行） */
function eventData(value: unknown): string {
  if (!isRecord(value)) throw new Reject(400);
  const rest: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!DATA_KEY.test(key)) throw new Reject(400);
    if (key !== 'stack') rest[key] = item;
    if (key === 'stack') {
      if (typeof item !== 'string' || item.length > STACK_MAX || DESCRIPTION_CONTROL.test(item)) throw new Reject(400);
    } else if (typeof item === 'string') {
      if (item.length > EVENT_DATA_STRING_MAX || CONTROL.test(item)) throw new Reject(400);
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Reject(400);
    } else if (typeof item !== 'boolean' && item !== null) {
      throw new Reject(400);
    }
  }
  // stack 本身 ≤ STACK_MAX 字；去掉 stack 后其余字段序列化 ≤ EVENT_DATA_MAX
  if (JSON.stringify(rest).length > EVENT_DATA_MAX) throw new Reject(400);
  return JSON.stringify(value);
}

function common(body: Record<string, unknown>): Common {
  const platform = shortString(body['platform'], 16);
  if (!PLATFORMS.has(platform)) throw new Reject(400);
  return {
    installId: shortString(body['installId'], 64),
    platform,
    appVersion: shortString(body['appVersion'], 32),
    os: shortString(body['os'], 64),
  };
}

/** 读 body 超时：不回响应，直接销毁连接 */
class BodyTimeout extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new Reject(413));
      return;
    }
    const timer = setTimeout(() => {
      req.removeAllListeners('data');
      reject(new BodyTimeout());
    }, BODY_TIMEOUT_MS);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        clearTimeout(timer);
        chunks.length = 0;
        reject(new Reject(413));
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.once('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    req.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function inflate(raw: Buffer, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzip(raw, { maxOutputLength: limit }, (err, out) => {
      if (err === null) resolve(out);
      else reject(new Reject((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 400));
    });
  });
}

export function createCollector(o: CollectorOptions): Collector {
  let stmts: Statements | null = null;
  let closed = false;
  let active = 0;
  const writes: { t: number; bytes: number }[] = [];
  const eventHits = new Map<string, number[]>();
  const feedbackHits = new Map<string, number[]>();
  const installDaily = new Map<string, { day: number; count: number }>();

  // 懒打开：路径有问题只让收集请求报 500，不会让中继启动失败或影响转发
  const open = (): Statements => {
    if (closed) throw new Reject(503);
    if (stmts !== null) return stmts;
    mkdirSync(dirname(o.dbPath), { recursive: true });
    const db = new DatabaseSync(o.dbPath);
    try {
      db.exec('PRAGMA journal_mode = DELETE');
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          received_at INTEGER NOT NULL,
          install_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          app_version TEXT NOT NULL,
          os TEXT NOT NULL,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          data_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_received ON events (received_at);
        CREATE INDEX IF NOT EXISTS events_install ON events (install_id);
        CREATE TABLE IF NOT EXISTS feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          received_at INTEGER NOT NULL,
          install_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          app_version TEXT NOT NULL,
          os TEXT NOT NULL,
          description TEXT NOT NULL,
          contact TEXT,
          logs TEXT
        );
        CREATE INDEX IF NOT EXISTS feedback_install ON feedback (install_id);
      `);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      stmts = {
        db,
        insertEvent: db.prepare(
          'INSERT INTO events (received_at, install_id, platform, app_version, os, kind, name, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ),
        insertFeedback: db.prepare(
          'INSERT INTO feedback (received_at, install_id, platform, app_version, os, description, contact, logs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ),
      };
      return stmts;
    } catch (err) {
      db.close();
      throw err;
    }
  };

  const overLimit = (hits: Map<string, number[]>, key: string, max: number): boolean => {
    const t = o.now();
    const recent = (hits.get(key) ?? []).filter((h) => t - h < WINDOW_MS);
    recent.push(t);
    hits.set(key, recent);
    return recent.length > max;
  };

  const storageFull = (s: Statements): boolean => {
    const row = s.db.prepare('SELECT (SELECT page_count FROM pragma_page_count) * (SELECT page_size FROM pragma_page_size) AS bytes').get() as { bytes: number };
    return row.bytes >= o.maxBytes;
  };

  /** 全局（不分 IP）每分钟写入量上限，按解压后字节计；超过返回 429 */
  const reserveWrite = (bytes: number): void => {
    const t = o.now();
    while (writes.length > 0 && t - writes[0]!.t >= WINDOW_MS) writes.shift();
    if (writes.reduce((sum, w) => sum + w.bytes, 0) + bytes > WRITE_CAP_BYTES) throw new Reject(429);
    writes.push({ t, bytes });
  };

  const readJson = async (
    req: IncomingMessage,
    maxRaw: number,
    maxInflated: number,
  ): Promise<{ body: Record<string, unknown>; bytes: number }> => {
    const encoding = req.headers['content-encoding'];
    if (encoding !== undefined && encoding !== 'gzip' && encoding !== 'identity') throw new Reject(400);
    let body = await readBody(req, maxRaw);
    if (encoding === 'gzip') body = await inflate(body, maxInflated);
    else if (body.length > maxInflated) throw new Reject(413);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw new Reject(400);
    }
    if (!isRecord(parsed)) throw new Reject(400);
    return { body: parsed, bytes: body.length };
  };

  const events = async (req: IncomingMessage, ip: string): Promise<void> => {
    if (overLimit(eventHits, ip, EVENTS_PER_MINUTE)) throw new Reject(429);
    const { body, bytes } = await readJson(req, EVENTS_MAX_RAW, EVENTS_MAX_INFLATED);
    const list = body['events'];
    if (!Array.isArray(list)) throw new Reject(400);
    if (list.length > EVENTS_MAX_COUNT) throw new Reject(413);
    const meta = common(body);
    const parsed = list.map((item: unknown) => {
      if (!isRecord(item)) throw new Reject(400);
      const ts = item['ts'];
      const kind = shortString(item['kind'], 16);
      const data = item['data'];
      if (typeof ts !== 'number' || !Number.isFinite(ts) || !KINDS.has(kind)) throw new Reject(400);
      const name = item['name'];
      if (typeof name !== 'string' || !EVENT_NAME.test(name)) throw new Reject(400);
      return { kind, name, dataJson: eventData(data) };
    });
    reserveWrite(bytes);
    const s = open();
    if (storageFull(s)) throw new Reject(507);
    const receivedAt = o.now();
    s.db.exec('BEGIN');
    try {
      for (const e of parsed) {
        s.insertEvent.run(receivedAt, meta.installId, meta.platform, meta.appVersion, meta.os, e.kind, e.name, e.dataJson);
      }
      s.db.exec('COMMIT');
    } catch (err) {
      s.db.exec('ROLLBACK');
      throw err;
    }
    o.log(`收集：事件 ${parsed.length} 条`);
  };

  const feedback = async (req: IncomingMessage, ip: string): Promise<void> => {
    if (overLimit(feedbackHits, ip, FEEDBACK_PER_MINUTE)) throw new Reject(429);
    const { body, bytes } = await readJson(req, FEEDBACK_MAX_RAW, FEEDBACK_MAX_INFLATED);
    const meta = common(body);
    const description = body['description'];
    // 描述允许换行与制表符，其余控制字符不允许
    if (typeof description !== 'string' || description.length === 0 || description.length > DESCRIPTION_MAX || DESCRIPTION_CONTROL.test(description)) {
      throw new Reject(400);
    }
    const contact = body['contact'] === undefined ? null : shortString(body['contact'], CONTACT_MAX);
    const logs = body['logs'];
    if (logs !== undefined && typeof logs !== 'string') throw new Reject(400);
    const day = Math.floor(o.now() / DAY_MS);
    const daily = installDaily.get(meta.installId);
    const count = daily !== undefined && daily.day === day ? daily.count : 0;
    if (count >= FEEDBACK_PER_INSTALL_PER_DAY) throw new Reject(429);
    reserveWrite(bytes);
    const s = open();
    if (storageFull(s)) throw new Reject(507);
    s.insertFeedback.run(o.now(), meta.installId, meta.platform, meta.appVersion, meta.os, description, contact, logs ?? null);
    installDaily.set(meta.installId, { day, count: count + 1 });
    o.log('收集：反馈 1 条');
  };

  const sweep = setInterval(() => {
    const t = o.now();
    for (const hits of [eventHits, feedbackHits]) {
      for (const [key, list] of hits) {
        if (list.every((h) => t - h >= WINDOW_MS)) hits.delete(key);
      }
    }
    const day = Math.floor(t / DAY_MS);
    for (const [key, value] of installDaily) {
      if (value.day !== day) installDaily.delete(key);
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  const finish = (req: IncomingMessage, res: ServerResponse, status: number): void => {
    if (!req.complete) {
      // 请求体还没读完（超限或限流）：先回响应，再丢弃有限的剩余数据后断开，
      // 立刻断开会让客户端在读到响应前收到连接重置
      let drained = 0;
      const stop = setTimeout(() => req.socket.destroy(), DRAIN_TIMEOUT_MS);
      stop.unref();
      req.on('data', (chunk: Buffer) => {
        drained += chunk.length;
        if (drained > DRAIN_MAX_BYTES) req.socket.destroy();
      });
      req.once('close', () => clearTimeout(stop));
      req.resume();
      res.shouldKeepAlive = false;
      res.setHeader('connection', 'close');
    }
    res.writeHead(status).end();
  };

  return {
    async handle(req, res, ip) {
      const path = (req.url ?? '').split('?')[0];
      const route = path === '/collect/v1/events' ? events : path === '/collect/v1/feedback' ? feedback : null;
      if (route === null || req.method !== 'POST') {
        finish(req, res, 404);
        return;
      }
      if (active >= MAX_CONCURRENT) {
        finish(req, res, 503);
        return;
      }
      active += 1;
      try {
        await route(req, ip);
        finish(req, res, 204);
      } catch (err) {
        if (err instanceof BodyTimeout) {
          req.socket.destroy();
          return;
        }
        if (err instanceof Reject) {
          finish(req, res, err.status);
          return;
        }
        o.log(`收集错误：${err instanceof Error ? err.message : 'unknown'}`);
        finish(req, res, 500);
      } finally {
        active -= 1;
      }
    },
    close() {
      closed = true;
      clearInterval(sweep);
      try {
        stmts?.db.close();
      } catch {
        // 已关闭
      }
      stmts = null;
    },
  };
}
