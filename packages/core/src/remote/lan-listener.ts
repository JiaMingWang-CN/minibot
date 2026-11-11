import http from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Carrier } from './channel.ts';

// 局域网直连：监听 0.0.0.0:port，只接受路径 /v1 的 WebSocket 升级，其余一律 404。

const MAX_FRAME_BYTES = 67584;
const PING_INTERVAL_MS = 25_000;

export class LanListener {
  private readonly server: http.Server;
  private readonly wss: WebSocketServer;
  private readonly heartbeat: NodeJS.Timeout;

  private constructor(server: http.Server, wss: WebSocketServer, heartbeat: NodeJS.Timeout) {
    this.server = server;
    this.wss = wss;
    this.heartbeat = heartbeat;
  }

  /** 启动失败时 reject，错误带 code（如 EADDRINUSE） */
  static async start(port: number, accept: (carrier: Carrier) => void): Promise<LanListener> {
    const server = http.createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    const alive = new WeakMap<WebSocket, boolean>();

    server.on('upgrade', (req, socket, head) => {
      let pathname = '';
      try {
        pathname = new URL(req.url ?? '/', 'http://lan').pathname;
      } catch {
        pathname = '';
      }
      if (pathname !== '/v1') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        alive.set(ws, true);
        ws.on('pong', () => alive.set(ws, true));
        ws.on('error', () => {});
        accept(wsCarrier(ws));
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', () => {});

    const heartbeat = setInterval(() => {
      for (const ws of wss.clients) {
        if (alive.get(ws) === false) {
          ws.terminate();
          continue;
        }
        alive.set(ws, false);
        ws.ping();
      }
    }, PING_INTERVAL_MS);
    heartbeat.unref();
    return new LanListener(server, wss, heartbeat);
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const ws of this.wss.clients) ws.terminate();
    const wssClosed = new Promise<void>((resolve) => this.wss.close(() => resolve()));
    this.server.closeAllConnections?.();
    const httpClosed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    await Promise.all([wssClosed, httpClosed]);
  }
}

function wsCarrier(ws: WebSocket): Carrier {
  let frameCb: ((frame: Buffer) => void) | null = null;
  const closeCbs: (() => void)[] = [];
  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (!isBinary) return;
    const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    frameCb?.(buffer);
  });
  ws.on('close', () => {
    for (const cb of closeCbs) cb();
  });
  return {
    send: (frame) => {
      if (ws.readyState === ws.OPEN) ws.send(frame, { binary: true });
    },
    onFrame: (cb) => {
      frameCb = cb;
    },
    onClose: (cb) => {
      closeCbs.push(cb);
    },
    close: () => ws.close(),
  };
}
