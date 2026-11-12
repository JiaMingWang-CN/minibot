import { createHash, createHmac } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import type { Carrier } from './channel.ts';
import { x25519, type KeyPair } from './noise.ts';
import { deviceIdOf } from './store.ts';
import type { DiagLog } from '../diag/log.ts';

// 电脑端到中继的出站连接：收到 session_open 就为该手机会话造一个 Carrier 交给网关。

export type RelayLinkState = 'connecting' | 'connected' | 'error';

export interface RelayLinkOptions {
  url: string;
  token: string;
  /** 电脑的长期身份：路由 ID 由公钥算出，私钥用来回答中继的身份挑战 */
  identity: KeyPair;
  accept: (carrier: Carrier) => void;
  onState: (state: RelayLinkState, error: string | null) => void;
  initialBackoffMs?: number;
  /** 测试用，默认 25000：隔这么久发一次 ping，下一轮还没收到 pong 就断开重连 */
  pingIntervalMs?: number;
  /** 连接、断线与握手失败写进本地日志；绝不记录地址与口令 */
  diag?: DiagLog;
}

const MAX_BACKOFF_MS = 60_000;
const PING_INTERVAL_MS = 25_000;
const SESSION_ID_BYTES = 16;
const AUTH_LABEL = 'minibot-relay-auth/1';

/** 与中继 packages/relay/src/relay.ts 的 pcProof 同一公式 */
function pcProof(shared: Buffer, nonce: Buffer, routeId: string): string {
  const key = createHash('sha256').update(AUTH_LABEL).update(shared).digest();
  return createHmac('sha256', key).update(nonce).update(Buffer.from(routeId, 'hex')).digest('base64url');
}

interface SessionCarrier extends Carrier {
  deliver(frame: Buffer): void;
  remoteClosed(): void;
}

function makeCarrier(
  sessionId: string,
  link: { send: (frame: Buffer) => void; closeSession: (id: string) => void; bufferedAmount: () => number },
): SessionCarrier {
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
    // 所有手机会话共用一条到中继的连接，积压按整条连接算
    bufferedAmount: link.bufferedAmount,
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
  /** 上一次断开是被顶替：重连成功后不重置退避，避免两份同身份实例每秒互踢 */
  private replaced = false;
  private readonly routeId: string;
  /** 自上次连上以来是否已经上报过失败事件，避免每次退避重连都发一条 */
  private reported = false;

  constructor(o: RelayLinkOptions) {
    this.o = o;
    this.backoff = o.initialBackoffMs ?? 1000;
    this.routeId = deviceIdOf(o.identity.publicKey);
  }

  start(): void {
    this.connect();
  }

  /** 因口令错误、身份被拒或地址无效而停止，不会再自己重连 */
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
      this.o.diag?.write('error', 'remote', 'relay.badurl', {}, { kind: 'error', name: 'remote.connect', data: { errorCode: 'bad_url' } });
      this.o.onState('error', '中继地址无效');
      this.stopped = true;
      return;
    }
    this.ws = ws;
    let failure: string | null = null;
    let errorCode: string | undefined;
    // 电脑睡眠、换网络后连接可能半开：本地一直是 OPEN 却再也收不到东西，靠心跳发现并重连
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          role: 'pc',
          routeId: this.routeId,
          token: this.o.token,
          pk: this.o.identity.publicKey.toString('base64url'),
        }),
      );
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
      if (message['type'] === 'challenge' && typeof message['epk'] === 'string' && typeof message['nonce'] === 'string') {
        let proof: string;
        try {
          const shared = x25519(this.o.identity.privateKey, Buffer.from(message['epk'], 'base64url'));
          proof = pcProof(shared, Buffer.from(message['nonce'], 'base64url'), this.routeId);
        } catch {
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ type: 'proof', proof }));
      } else if (message['type'] === 'welcome') {
        if (!this.replaced) this.backoff = this.o.initialBackoffMs ?? 1000;
        this.replaced = false;
        this.reported = false;
        this.o.diag?.write('info', 'remote', 'relay.connected');
        this.o.onState('connected', null);
      } else if (message['type'] === 'session_open' && typeof message['sessionId'] === 'string') {
        const sessionId = message['sessionId'];
        if (!/^[0-9a-f]{32}$/.test(sessionId)) return;
        this.sessions.get(sessionId)?.remoteClosed();
        const carrier = makeCarrier(sessionId, {
          send: (frame) => {
            if (ws.readyState === ws.OPEN) ws.send(frame, { binary: true });
          },
          bufferedAmount: () => ws.bufferedAmount,
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
      errorCode = (err as NodeJS.ErrnoException).code;
      failure = describeError(err);
    });

    ws.on('close', (code: number) => {
      if (this.ws !== ws) return;
      this.stopHeartbeat();
      this.ws = null;
      this.dropSessions();
      this.reportClose(code, errorCode);
      if (code === 4401) {
        this.stopped = true;
        this.o.onState('error', '中继口令错误');
        return;
      }
      if (code === 4403) {
        this.stopped = true;
        this.o.onState('error', '中继拒绝了这台电脑的身份证明');
        return;
      }
      // 只有持有同一私钥的连接才能顶替（如同一数据目录开了两份）：按退避重连，不永久放弃
      if (code === 4409) {
        this.replaced = true;
        failure = '另一个使用同一身份的连接顶替了这台电脑';
      }
      if (code === 4429) failure = '中继拒绝了连接（请求过于频繁）';
      this.o.onState('error', failure ?? '与中继的连接已断开');
      this.scheduleReconnect();
    });
  }

  private reportClose(code: number, errorCode: string | undefined): void {
    const diag = this.o.diag;
    if (diag === undefined) return;
    const data = { code, ...(errorCode !== undefined ? { errorCode } : {}) };
    const first = !this.reported;
    this.reported = true;
    diag.write('warn', 'remote', 'relay.disconnected', data, first ? { kind: 'error', name: 'remote.connect', data } : undefined);
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
