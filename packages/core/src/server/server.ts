import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { URL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Kernel } from '../kernel.ts';
import { handleApi, sendJson } from './routes.ts';

const AUTH_TIMEOUT_MS = 5000;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface ServerOptions {
  staticDir: string;
  port?: number;
}

export interface ServerHandle {
  port: number;
  token: string;
  origin: string;
  close(): Promise<void>;
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return safeEqual(header.slice(prefix.length), token);
}

export async function startServer(kernel: Kernel, o: ServerOptions): Promise<ServerHandle> {
  const token = randomBytes(32).toString('base64url');
  const staticDir = path.resolve(o.staticDir);
  let port = 0;
  let origin = '';
  let closed = false;

  const serveStatic = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<void> => {
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' });
      res.end();
      return;
    }
    let relative: string | null = null;
    if (pathname === '/' || pathname === '/index.html') relative = 'index.html';
    else if (pathname.startsWith('/assets/')) relative = pathname.slice(1);
    if (relative === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const resolved = path.resolve(staticDir, relative);
    const base = staticDir.endsWith(path.sep) ? staticDir : `${staticDir}${path.sep}`;
    if (resolved !== staticDir && !resolved.startsWith(base)) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const content = await fs.readFile(resolved);
      res.writeHead(200, {
        'content-type': MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(content.length),
        // 脚本只允许本机来源；样式要放开内联：Astryx 运行时往 <head> 插 <style>（弹出层定位、代码高亮），不支持 nonce。
        // 图片附件需带令牌读取，界面把它转成 blob: 地址显示。
        'content-security-policy': `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self' ws://127.0.0.1:${port}`,
        'x-content-type-options': 'nosniff',
      });
      res.end(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(500);
      res.end();
    }
  };

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const host = req.headers.host;
      if (host !== `127.0.0.1:${port}`) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (req.method === 'OPTIONS') {
        res.writeHead(405);
        res.end();
        return;
      }
      if (url.pathname.startsWith('/api')) {
        if (!bearerMatches(req.headers.authorization, token)) {
          sendJson(res, 401, { error: { code: 'unauthorized', message: '令牌无效' } });
          return;
        }
        await handleApi(kernel, req, res, url);
        return;
      }
      await serveStatic(req, res, url.pathname);
    })();
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const host = req.headers.host;
    const requestOrigin = req.headers.origin;
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      pathname = '';
    }
    if (host !== `127.0.0.1:${port}` || requestOrigin !== origin || pathname !== '/ws') {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    let authenticated = false;
    const timer = setTimeout(() => {
      if (!authenticated) ws.close(4401, 'unauthorized');
    }, AUTH_TIMEOUT_MS);
    const unsubscribe = kernel.on((event) => {
      if (authenticated && ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    });

    ws.on('message', (data: WebSocket.RawData) => {
      let message: unknown;
      try {
        message = JSON.parse(String(data));
      } catch {
        message = null;
      }
      if (!authenticated) {
        const candidate = message as { type?: unknown; token?: unknown } | null;
        if (candidate?.type === 'auth' && typeof candidate.token === 'string' && safeEqual(candidate.token, token)) {
          authenticated = true;
          clearTimeout(timer);
        } else {
          ws.close(4401, 'unauthorized');
        }
        return;
      }
      const msg = message as Record<string, unknown> | null;
      if (msg?.['type'] === 'abort' && typeof msg['threadId'] === 'string') {
        kernel.abort(msg['threadId']);
      } else if (
        msg?.['type'] === 'approval' &&
        typeof msg['id'] === 'string' &&
        typeof msg['approve'] === 'boolean'
      ) {
        kernel.respondApproval(msg['id'], msg['approve'], msg['always'] === true);
      }
    });

    ws.on('close', () => {
      clearTimeout(timer);
      unsubscribe();
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(o.port ?? 0, '127.0.0.1', () => {
      const address = httpServer.address() as AddressInfo;
      port = address.port;
      origin = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  return {
    port,
    token,
    origin,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const client of wss.clients) client.terminate();
      const wssClosed = new Promise<void>((resolve) => wss.close(() => resolve()));
      httpServer.closeAllConnections?.();
      const httpClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await Promise.all([wssClosed, httpClosed]);
    },
  };
}
