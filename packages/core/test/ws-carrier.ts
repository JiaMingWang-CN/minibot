import { WebSocket } from 'ws';
import type { Carrier } from '../src/remote/channel.ts';

// 测试用：把 ws 客户端连接包成 Carrier（只收发二进制帧）。

export function wsCarrier(ws: WebSocket, onText?: (message: Record<string, unknown>) => void): Carrier {
  let frameCb: ((frame: Buffer) => void) | null = null;
  const closeCbs: (() => void)[] = [];
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) frameCb?.(Buffer.from(data));
    else onText?.(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
  });
  ws.on('close', () => {
    for (const cb of closeCbs) cb();
  });
  ws.on('error', () => {});
  return {
    send: (frame) => ws.send(frame, { binary: true }),
    onFrame: (cb) => {
      frameCb = cb;
    },
    onClose: (cb) => {
      closeCbs.push(cb);
    },
    close: () => ws.close(),
  };
}

export function openWs(url: string, options?: ConstructorParameters<typeof WebSocket>[2]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
