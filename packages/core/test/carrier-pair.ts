import type { Carrier } from '../src/remote/channel.ts';

// 测试用：一对内存承载，帧经微任务异步投递；可记录每帧长度、可注入重复帧。

export interface MemoryCarrier extends Carrier {
  sent: Buffer[];
}

export function carrierPair(): { a: MemoryCarrier; b: MemoryCarrier } {
  const make = (): MemoryCarrier & { peer: MemoryCarrier | null; frameCb: ((f: Buffer) => void) | null; closeCb: (() => void)[]; closed: boolean } => {
    const self = {
      peer: null as MemoryCarrier | null,
      frameCb: null as ((f: Buffer) => void) | null,
      closeCb: [] as (() => void)[],
      closed: false,
      sent: [] as Buffer[],
      send(frame: Buffer) {
        if (self.closed) return;
        self.sent.push(frame);
        const peer = self.peer as unknown as typeof self;
        queueMicrotask(() => {
          if (!peer.closed) peer.frameCb?.(frame);
        });
      },
      onFrame(cb: (f: Buffer) => void) {
        self.frameCb = cb;
      },
      onClose(cb: () => void) {
        self.closeCb.push(cb);
      },
      close() {
        if (self.closed) return;
        self.closed = true;
        for (const cb of self.closeCb) cb();
        const peer = self.peer as unknown as typeof self;
        queueMicrotask(() => {
          if (!peer.closed) peer.close();
        });
      },
    };
    return self;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return { a, b };
}
