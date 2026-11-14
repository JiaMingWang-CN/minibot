import { FRAME_KK, FRAME_PAIR, SecureChannel, type Carrier } from '../src/remote/channel.ts';
import { createHandshake, generateKeyPair, type KeyPair } from '../src/remote/noise.ts';
import { parsePairingCode } from '../src/remote/pairing.ts';
import { deviceIdOf } from '../src/remote/store.ts';
import type { KernelEvent } from '../src/events.ts';

// 测试用"手机"：用 Node 实现手机侧的握手与应用层协议，验证电脑端全链路。

export interface PhoneResponse {
  status: number;
  body?: unknown;
  bytes?: string;
  contentType?: string;
}

/**
 * 握手最后一帧之后，电脑端会紧接着发 ready。帧处理函数换手时可能有帧已到达，
 * 所以用缓冲包装：没有处理函数时先排队，设置处理函数后再补发。
 */
function buffered(carrier: Carrier): Carrier & { pull(): Promise<Buffer> } {
  const queue: Buffer[] = [];
  let handler: ((frame: Buffer) => void) | null = null;
  let waiter: { resolve: (f: Buffer) => void; reject: (e: Error) => void } | null = null;
  carrier.onFrame((frame) => {
    if (waiter !== null) {
      const w = waiter;
      waiter = null;
      w.resolve(frame);
    } else if (handler === null) queue.push(frame);
    else handler(frame);
  });
  carrier.onClose(() => {
    waiter?.reject(new Error('连接已关闭'));
    waiter = null;
  });
  return {
    send: (frame) => carrier.send(frame),
    onFrame: (cb) => {
      handler = cb;
      queueMicrotask(() => {
        while (queue.length > 0 && handler === cb) cb(queue.shift()!);
      });
    },
    onClose: (cb) => carrier.onClose(cb),
    close: () => carrier.close(),
    pull: () =>
      new Promise<Buffer>((resolve, reject) => {
        const first = queue.shift();
        if (first !== undefined) resolve(first);
        else waiter = { resolve, reject };
      }),
  };
}

export class TestPhone {
  readonly keys: KeyPair;
  readonly channel: SecureChannel;
  readonly messages: Record<string, unknown>[] = [];
  readonly events: KernelEvent[] = [];
  pcName = '';
  pcPublicKey: Buffer;
  closed = false;
  private nextId = 1;
  private readonly pending = new Map<string, (r: PhoneResponse) => void>();
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;

  private constructor(keys: KeyPair, pcPublicKey: Buffer, channel: SecureChannel) {
    this.keys = keys;
    this.pcPublicKey = pcPublicKey;
    this.channel = channel;
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.ready.catch(() => {});
    channel.onClose(() => {
      this.closed = true;
      this.readyReject(new Error('连接已关闭'));
    });
    channel.onMessage((raw) => {
      const m = raw as Record<string, unknown>;
      this.messages.push(m);
      if (m['t'] === 'ready') {
        this.pcName = String(m['pcName']);
        this.readyResolve();
      } else if (m['t'] === 'evt') {
        this.events.push(m['event'] as KernelEvent);
      } else if (m['t'] === 'res') {
        this.pending.get(String(m['id']))?.(m as unknown as PhoneResponse);
        this.pending.delete(String(m['id']));
      }
    });
  }

  /** 扫码配对，resolve 时已收到 ready */
  static async pair(
    rawCarrier: Carrier,
    code: string,
    deviceName = '测试手机',
    o: { psk?: Buffer; keys?: KeyPair } = {},
  ): Promise<TestPhone> {
    const carrier = buffered(rawCarrier);
    const info = parsePairingCode(code);
    const keys = o.keys ?? generateKeyPair();
    const pk = Buffer.from(info.pk, 'base64url');
    const hs = createHandshake({
      pattern: 'XXpsk3',
      initiator: true,
      s: keys,
      psk: o.psk ?? Buffer.from(info.psk, 'base64url'),
    });
    carrier.send(Buffer.concat([Buffer.from([FRAME_PAIR]), hs.writeMessage(Buffer.alloc(0))]));
    const frame = await carrier.pull();
    if (frame[0] !== FRAME_PAIR) throw new Error('意外的帧');
    hs.readMessage(frame.subarray(1));
    carrier.send(
      Buffer.concat([Buffer.from([FRAME_PAIR]), hs.writeMessage(Buffer.from(JSON.stringify({ deviceName }), 'utf8'))]),
    );
    const { send, recv } = hs.split();
    const phone = new TestPhone(keys, pk, new SecureChannel(carrier, send, recv));
    await phone.ready;
    return phone;
  }

  /** 日常连接（KK），resolve 时已收到 ready */
  static async connect(rawCarrier: Carrier, keys: KeyPair, pcPublicKey: Buffer): Promise<TestPhone> {
    const carrier = buffered(rawCarrier);
    const hs = createHandshake({ pattern: 'KK', initiator: true, s: keys, rs: pcPublicKey });
    carrier.send(
      Buffer.concat([
        Buffer.from([FRAME_KK]),
        Buffer.from(deviceIdOf(keys.publicKey), 'hex'),
        hs.writeMessage(Buffer.alloc(0)),
      ]),
    );
    const frame = await carrier.pull();
    if (frame[0] !== FRAME_KK) throw new Error('意外的帧');
    hs.readMessage(frame.subarray(1));
    const { send, recv } = hs.split();
    const phone = new TestPhone(keys, pcPublicKey, new SecureChannel(carrier, send, recv));
    await phone.ready;
    // 真实手机收到 ready 后立刻发 version，电脑端以首个可解密的数据帧作为会话建立；这里发一条会被忽略的帧
    phone.channel.send({ t: 'hello' });
    return phone;
  }

  request(method: string, path: string, body?: unknown): Promise<PhoneResponse> {
    const id = String(this.nextId++);
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.channel.send({ t: 'req', id, method, path, ...(body !== undefined ? { body } : {}) });
    });
  }

  control(msg: Record<string, unknown>): void {
    this.channel.send({ t: 'ctl', msg });
  }

  close(): void {
    this.channel.close();
  }
}
