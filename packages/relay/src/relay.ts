import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

// 中继：电脑与手机各自向它建立出站连接，它按 routeId 配对并只转发密文小块，不解析负载。

export const MAX_FRAME_BYTES = 67584;
const HELLO_TIMEOUT_MS = 5000;
const MAX_HELLO_BYTES = 4096;
const MAX_PHONES_PER_ROUTE = 8;
const IP_WINDOW_MS = 60_000;
const IP_MAX_CONNECTIONS = 30;
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 60_000;
const SESSION_ID_BYTES = 16;
const HEX32 = /^[0-9a-f]{32}$/;

export interface RelayOptions {
  host: string;
  port: number;
  token: string;
  now?: () => number;
  /** 只用于连接数变化与错误，绝不含负载 */
  log?: (message: string) => void;
  /** 测试用，默认 5000 */
  helloTimeoutMs?: number;
  /**
   * 部署在本机反代（如 Caddy）后面时打开：来自回环地址的连接按 X-Forwarded-For
   * 最右边一项（反代追加的真实客户端地址）限流，否则所有人都是 127.0.0.1。
   */
  trustProxy?: boolean;
}

export interface RelayHandle {
  port: number;
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
  const routes = new Map<string, Route>();
  const ipHits = new Map<string, number[]>();
  const lastPong = new WeakMap<WebSocket, number>();
  let connections = 0;

  // maxPayload 放宽，由我们自己按 MAX_FRAME_BYTES 以 4413 关闭（ws 自带的超限关闭码是 1009）
  const wss = new WebSocketServer({ host: o.host, port: o.port, path: '/v1', maxPayload: 1024 * 1024 });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve());
    wss.once('error', reject);
  });
  wss.on('error', (err) => log(`中继错误：${err.message}`));

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
      if (phone !== undefined && phone.readyState === phone.OPEN) {
        phone.send(buffer.subarray(SESSION_ID_BYTES), { binary: true });
      }
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
      if (pc !== null && pc.readyState === pc.OPEN) {
        pc.send(Buffer.concat([sessionBytes, buffer]), { binary: true });
      }
    });

    ws.on('close', () => {
      if (route.phones.get(sessionId) === ws) {
        route.phones.delete(sessionId);
        if (route.pc !== null) sendJson(route.pc, { type: 'session_close', sessionId });
      }
      dropRouteIfEmpty(routeId, route);
    });
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
      if (hello['role'] === 'pc') attachPc(ws, hello['routeId']);
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
  }, PING_INTERVAL_MS);
  heartbeat.unref();

  return {
    port: (wss.address() as AddressInfo).port,
    close: async () => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
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
