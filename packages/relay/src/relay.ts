import {
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { createCollector, type Collector } from './collect.ts';

// 中继：电脑与手机各自向它建立出站连接，它按 routeId 配对并只转发密文小块，不解析负载。
//
// 电脑要证明自己持有路由对应的私钥（口令写在配对二维码里，不能当身份凭证）：
//   电脑 hello 带上公钥 pk，中继核对 routeId == SHA-256(pk) 前 16 字节；
//   中继发 {type:'challenge', epk, nonce}（epk 为一次性 X25519 公钥）；
//   电脑回 {type:'proof', proof}，proof = HMAC-SHA256(SHA-256("minibot-relay-auth/1" || X25519(电脑私钥, epk)), nonce || routeId)；
//   中继用 X25519(一次性私钥, pk) 算出同样的值才接纳这台电脑。

export const MAX_FRAME_BYTES = 67584;
const HELLO_TIMEOUT_MS = 5000;
const MAX_HELLO_BYTES = 4096;
const MAX_PHONES_PER_ROUTE = 8;
const IP_WINDOW_MS = 60_000;
const IP_MAX_CONNECTIONS = 30;
const PING_INTERVAL_MS = 25_000;
/** 对端发送缓冲积压上限：超过就关掉那条连接，而不是无限缓存 */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const PONG_TIMEOUT_MS = 60_000;
const SESSION_ID_BYTES = 16;
const HEX32 = /^[0-9a-f]{32}$/;
const AUTH_LABEL = 'minibot-relay-auth/1';
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/** 电脑身份证明；电脑端 relay-link.ts 用同一公式 */
export function pcProof(shared: Buffer, nonce: Buffer, routeId: string): Buffer {
  const key = createHash('sha256').update(AUTH_LABEL).update(shared).digest();
  return createHmac('sha256', key).update(nonce).update(Buffer.from(routeId, 'hex')).digest();
}

function x25519Public(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

export interface RelayOptions {
  host: string;
  port: number;
  token: string;
  now?: () => number;
  /** 只用于连接数变化与错误，绝不含负载 */
  log?: (message: string) => void;
  /** 测试用，默认 5000 */
  helloTimeoutMs?: number;
  /** 测试用，默认 25000 */
  pingIntervalMs?: number;
  /** 测试用，默认 16 MiB */
  maxBufferedBytes?: number;
  /**
   * 部署在本机反代（如 Caddy）后面时打开：来自回环地址的连接按 X-Forwarded-For
   * 最右边一项（反代追加的真实客户端地址）限流，否则所有人都是 127.0.0.1。
   */
  trustProxy?: boolean;
  /** 设置后启用 /collect/v1/* 诊断收集；不设则这些路径一律 404 且不创建任何文件 */
  collect?: { dbPath: string; maxBytes: number };
}

export interface RelayHandle {
  port: number;
  /** 测试用：限流表里当前记着的 IP 个数 */
  trackedIps(): number;
  close(): Promise<void>;
}

interface Route {
  pc: WebSocket | null;
  phones: Map<string, WebSocket>;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function tokenMatches(candidate: string, token: string): boolean {
  return timingSafeEqual(digest(candidate), digest(token));
}

function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  if (!trustProxy || !isLoopback(remote)) return remote;
  const header = req.headers['x-forwarded-for'];
  const value = Array.isArray(header) ? header.join(',') : header;
  const last = value?.split(',').map((part) => part.trim()).filter((part) => part.length > 0).pop();
  return last ?? remote;
}

function sendJson(ws: WebSocket, message: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

export async function startRelay(o: RelayOptions): Promise<RelayHandle> {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const helloTimeoutMs = o.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const maxBuffered = o.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  const routes = new Map<string, Route>();
  const ipHits = new Map<string, number[]>();
  const lastPong = new WeakMap<WebSocket, number>();
  let connections = 0;

  // maxPayload 放宽，由我们自己按 MAX_FRAME_BYTES 以 4413 关闭（ws 自带的超限关闭码是 1009）
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const collector: Collector | null =
    o.collect === undefined ? null : createCollector({ ...o.collect, now, log });
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (collector !== null && path.startsWith('/collect/v1/')) {
      // handle 内部已兜住所有异常；这里再兜一层，收集路径出错绝不外溢
      collector.handle(req, res, clientIp(req, o.trustProxy === true)).catch((err: unknown) => {
        log(`收集错误：${err instanceof Error ? err.message : 'unknown'}`);
        if (!res.headersSent) res.writeHead(500).end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/v1') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      return;
    }
    socket.on('error', () => {});
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
    server.listen(o.port, o.host);
  });
  server.on('error', (err) => log(`中继错误：${err.message}`));
  wss.on('error', (err) => log(`中继错误：${err.message}`));

  // 向对端转发；对端读得太慢、积压超限就关掉它（电脑重连、手机重新进入都会恢复）
  const forward = (target: WebSocket, payload: Buffer): void => {
    if (target.readyState !== target.OPEN) return;
    if (target.bufferedAmount > maxBuffered) {
      target.close(4408, 'backlog');
      return;
    }
    target.send(payload, { binary: true });
  };

  const rateLimited = (ip: string): boolean => {
    const t = now();
    const hits = (ipHits.get(ip) ?? []).filter((h) => t - h < IP_WINDOW_MS);
    hits.push(t);
    ipHits.set(ip, hits);
    return hits.length > IP_MAX_CONNECTIONS;
  };

  const routeOf = (routeId: string): Route => {
    let route = routes.get(routeId);
    if (route === undefined) {
      route = { pc: null, phones: new Map() };
      routes.set(routeId, route);
    }
    return route;
  };

  const dropRouteIfEmpty = (routeId: string, route: Route): void => {
    if (route.pc === null && route.phones.size === 0) routes.delete(routeId);
  };

  const openSession = (route: Route, sessionId: string, phone: WebSocket): void => {
    if (route.pc === null) return;
    sendJson(route.pc, { type: 'session_open', sessionId });
    sendJson(phone, { type: 'pc_online' });
  };

  const attachPc = (ws: WebSocket, routeId: string): void => {
    const route = routeOf(routeId);
    const old = route.pc;
    if (old !== null) {
      route.pc = null;
      for (const phone of route.phones.values()) sendJson(phone, { type: 'pc_offline' });
      old.close(4409, 'replaced');
    }
    route.pc = ws;
    sendJson(ws, { type: 'welcome' });
    for (const [sessionId, phone] of route.phones) openSession(route, sessionId, phone);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      const buffer = toBuffer(data);
      if (buffer.length > MAX_FRAME_BYTES) {
        ws.close(4413, 'frame too large');
        return;
      }
      if (!isBinary) {
        const message = parseJson(buffer);
        if (message?.['type'] === 'session_close' && typeof message['sessionId'] === 'string') {
          route.phones.get(message['sessionId'])?.close(1000, 'closed by pc');
        }
        return;
      }
      if (buffer.length < SESSION_ID_BYTES) return;
      const sessionId = buffer.subarray(0, SESSION_ID_BYTES).toString('hex');
      const phone = route.phones.get(sessionId);
      if (phone !== undefined) forward(phone, buffer.subarray(SESSION_ID_BYTES));
    });

    ws.on('close', () => {
      if (route.pc !== ws) return;
      route.pc = null;
      for (const phone of route.phones.values()) sendJson(phone, { type: 'pc_offline' });
      dropRouteIfEmpty(routeId, route);
    });
  };

  const attachPhone = (ws: WebSocket, routeId: string): void => {
    const route = routeOf(routeId);
    if (route.phones.size >= MAX_PHONES_PER_ROUTE) {
      ws.close(4429, 'too many phones');
      dropRouteIfEmpty(routeId, route);
      return;
    }
    const sessionId = randomBytes(SESSION_ID_BYTES).toString('hex');
    const sessionBytes = Buffer.from(sessionId, 'hex');
    route.phones.set(sessionId, ws);
    sendJson(ws, { type: 'welcome' });
    if (route.pc !== null) openSession(route, sessionId, ws);
    else sendJson(ws, { type: 'pc_offline' });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      const buffer = toBuffer(data);
      if (buffer.length > MAX_FRAME_BYTES) {
        ws.close(4413, 'frame too large');
        return;
      }
      if (!isBinary) return;
      const pc = route.pc;
      if (pc !== null) forward(pc, Buffer.concat([sessionBytes, buffer]));
    });

    ws.on('close', () => {
      if (route.phones.get(sessionId) === ws) {
        route.phones.delete(sessionId);
        if (route.pc !== null) sendJson(route.pc, { type: 'session_close', sessionId });
      }
      dropRouteIfEmpty(routeId, route);
    });
  };

  const challengePc = (ws: WebSocket, routeId: string, rawPk: unknown): void => {
    const pk = typeof rawPk === 'string' ? Buffer.from(rawPk, 'base64url') : Buffer.alloc(0);
    if (pk.length !== 32 || createHash('sha256').update(pk).digest().subarray(0, 16).toString('hex') !== routeId) {
      ws.close(4403, 'identity mismatch');
      return;
    }
    const ephemeral = generateKeyPairSync('x25519');
    const epk = Buffer.from(ephemeral.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
    const nonce = randomBytes(32);
    const timer = setTimeout(() => ws.close(4400, 'proof timeout'), helloTimeoutMs);
    ws.on('close', () => clearTimeout(timer));
    ws.once('message', (data: RawData, isBinary: boolean) => {
      clearTimeout(timer);
      const buffer = toBuffer(data);
      const message = isBinary || buffer.length > MAX_HELLO_BYTES ? null : parseJson(buffer);
      if (message === null || message['type'] !== 'proof' || typeof message['proof'] !== 'string') {
        ws.close(4400, 'bad proof');
        return;
      }
      let expected: Buffer;
      try {
        expected = pcProof(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: x25519Public(pk) }), nonce, routeId);
      } catch {
        // 低阶点等无效公钥
        ws.close(4403, 'identity rejected');
        return;
      }
      const proof = Buffer.from(message['proof'], 'base64url');
      if (proof.length !== expected.length || !timingSafeEqual(proof, expected)) {
        ws.close(4403, 'identity rejected');
        return;
      }
      attachPc(ws, routeId);
    });
    sendJson(ws, { type: 'challenge', epk: epk.toString('base64url'), nonce: nonce.toString('base64url') });
  };

  wss.on('connection', (ws, req) => {
    connections += 1;
    log(`连接数：${connections}`);
    ws.on('close', () => {
      connections -= 1;
      log(`连接数：${connections}`);
    });
    ws.on('error', (err) => log(`连接错误：${err.message}`));
    lastPong.set(ws, now());
    ws.on('pong', () => lastPong.set(ws, now()));

    if (rateLimited(clientIp(req, o.trustProxy === true))) {
      ws.close(4429, 'rate limited');
      return;
    }

    const timer = setTimeout(() => ws.close(4400, 'hello timeout'), helloTimeoutMs);
    ws.on('close', () => clearTimeout(timer));

    ws.once('message', (data: RawData, isBinary: boolean) => {
      clearTimeout(timer);
      const buffer = toBuffer(data);
      const hello = isBinary || buffer.length > MAX_HELLO_BYTES ? null : parseJson(buffer);
      if (
        hello === null ||
        hello['type'] !== 'hello' ||
        (hello['role'] !== 'pc' && hello['role'] !== 'phone') ||
        typeof hello['routeId'] !== 'string' ||
        !HEX32.test(hello['routeId']) ||
        typeof hello['token'] !== 'string'
      ) {
        ws.close(4400, 'bad hello');
        return;
      }
      if (!tokenMatches(hello['token'], o.token)) {
        ws.close(4401, 'unauthorized');
        return;
      }
      // hello 之后的帧交给各角色的处理函数（once 只吃掉了 hello）
      if (hello['role'] === 'pc') challengePc(ws, hello['routeId'], hello['pk']);
      else attachPhone(ws, hello['routeId']);
    });
  });

  const heartbeat = setInterval(() => {
    const t = now();
    for (const ws of wss.clients) {
      if (t - (lastPong.get(ws) ?? t) > PONG_TIMEOUT_MS) {
        ws.terminate();
        continue;
      }
      ws.ping();
    }
    // 窗口内已没有命中的 IP 不再记着，否则公网中继的表只增不减
    for (const [ip, hits] of ipHits) {
      if (hits.every((h) => t - h >= IP_WINDOW_MS)) ipHits.delete(ip);
    }
  }, o.pingIntervalMs ?? PING_INTERVAL_MS);
  heartbeat.unref();

  return {
    port: (server.address() as AddressInfo).port,
    trackedIps: () => ipHits.size,
    close: async () => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      collector?.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function parseJson(buffer: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(buffer.toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
