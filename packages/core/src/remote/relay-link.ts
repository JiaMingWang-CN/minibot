import { WebSocket, type RawData } from 'ws';
import type { Carrier } from './channel.ts';

// 电脑端到中继的出站连接：收到 session_open 就为该手机会话造一个 Carrier 交给网关。

export type RelayLinkState = 'connecting' | 'connected' | 'error';

export interface RelayLinkOptions {
  url: string;
  token: string;
  routeId: string;
  accept: (carrier: Carrier) => void;
  onState: (state: RelayLinkState, error: string | null) => void;
  initialBackoffMs?: number;
  /** 测试用，默认 25000：隔这么久发一次 ping，下一轮还没收到 pong 就断开重连 */
  pingIntervalMs?: number;
}

const MAX_BACKOFF_MS = 60_000;
const PING_INTERVAL_MS = 25_000;
const SESSION_ID_BYTES = 16;

interface SessionCarrier extends Carrier {
  deliver(frame: Buffer): void;
  remoteClosed(): void;
}

function makeCarrier(sessionId: string, link: { send: (frame: Buffer) => void; closeSession: (id: string) => void }): SessionCarrier {
  const idBytes = Buffer.from(sessionId, 'hex');
  let frameCb: ((frame: Buffer) => void) | null = null;
  const closeCbs: (() => void)[] = [];
  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb();
  };
  return {
    send: (frame) => {
      if (!closed) link.send(Buffer.concat([idBytes, frame]));
    },
    onFrame: (cb) => {
      frameCb = cb;
    },
    onClose: (cb) => {
      closeCbs.push(cb);
    },
    close: () => {
      if (closed) return;
      link.closeSession(sessionId);
      finish();
    },
    deliver: (frame) => {
      if (!closed) frameCb?.(frame);
    },
    remoteClosed: finish,
  };
}

export class RelayLink {
  private readonly o: RelayLinkOptions;
  private ws: WebSocket | null = null;
  private readonly sessions = new Map<string, SessionCarrier>();
  private timer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private backoff: number;
  private stopped = false;

  constructor(o: RelayLinkOptions) {
    this.o = o;
    this.backoff = o.initialBackoffMs ?? 1000;
  }

  start(): void {
    this.connect();
  }

  /** 因口令错误、被顶替或地址无效而停止，不会再自己重连 */
  isStopped(): boolean {
    return this.stopped;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    this.dropSessions();
    ws?.removeAllListeners();
    ws?.on('error', () => {});
    ws?.terminate();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private dropSessions(): void {
    for (const carrier of [...this.sessions.values()]) carrier.remoteClosed();
    this.sessions.clear();
  }

  private connect(): void {
    if (this.stopped) return;
    this.o.onState('connecting', null);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.o.url, { maxPayload: 1024 * 1024 });
    } catch {
      this.o.onState('error', '中继地址无效');
      this.stopped = true;
      return;
    }
    this.ws = ws;
    let failure: string | null = null;
    // 电脑睡眠、换网络后连接可能半开：本地一直是 OPEN 却再也收不到东西，靠心跳发现并重连
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'pc', routeId: this.o.routeId, token: this.o.token }));
      this.stopHeartbeat();
      const heartbeat = setInterval(() => {
        if (!alive) {
          failure = '与中继的连接已失去响应';
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, this.o.pingIntervalMs ?? PING_INTERVAL_MS);
      heartbeat.unref();
      this.heartbeat = heartbeat;
    });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (isBinary) {
        if (buffer.length < SESSION_ID_BYTES) return;
        this.sessions.get(buffer.subarray(0, SESSION_ID_BYTES).toString('hex'))?.deliver(buffer.subarray(SESSION_ID_BYTES));
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message['type'] === 'welcome') {
        this.backoff = this.o.initialBackoffMs ?? 1000;
        this.o.onState('connected', null);
      } else if (message['type'] === 'session_open' && typeof message['sessionId'] === 'string') {
        const sessionId = message['sessionId'];
        if (!/^[0-9a-f]{32}$/.test(sessionId)) return;
        this.sessions.get(sessionId)?.remoteClosed();
        const carrier = makeCarrier(sessionId, {
          send: (frame) => {
            if (ws.readyState === ws.OPEN) ws.send(frame, { binary: true });
          },
          closeSession: (id) => {
            this.sessions.delete(id);
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'session_close', sessionId: id }));
          },
        });
        this.sessions.set(sessionId, carrier);
        this.o.accept(carrier);
      } else if (message['type'] === 'session_close' && typeof message['sessionId'] === 'string') {
        const carrier = this.sessions.get(message['sessionId']);
        this.sessions.delete(message['sessionId']);
        carrier?.remoteClosed();
      }
    });

    ws.on('error', (err: Error) => {
      failure = describeError(err);
    });

    ws.on('close', (code: number) => {
      if (this.ws !== ws) return;
      this.stopHeartbeat();
      this.ws = null;
      this.dropSessions();
      if (code === 4401) {
        this.stopped = true;
        this.o.onState('error', '中继口令错误');
        return;
      }
      if (code === 4409) {
        this.stopped = true;
        this.o.onState('error', '另一个连接占用了这个路由，已停止重连');
        return;
      }
      if (code === 4429) failure = '中继拒绝了连接（请求过于频繁）';
      this.o.onState('error', failure ?? '与中继的连接已断开');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    this.timer.unref();
  }
}

function describeError(err: Error): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '无法解析中继地址';
  if (code === 'ECONNREFUSED') return '中继拒绝连接';
  if (code === 'ETIMEDOUT') return '连接中继超时';
  return `无法连接中继：${err.message}`;
}
