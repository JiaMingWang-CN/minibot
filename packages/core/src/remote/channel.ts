import type { CipherState } from './noise.ts';

export const FRAME_PAIR = 0x01;
export const FRAME_KK = 0x02;
export const FRAME_DATA = 0x03;

/** 每块明文：1 字节标志 + 至多 65518 字节数据（加 16 字节标签后正好 65535） */
export const CHUNK_DATA_BYTES = 65518;
/** 拼回后的应用消息上限（36 MiB，覆盖发消息接口的 32 MB） */
export const MAX_APP_MESSAGE_BYTES = 37748736;
/** 承载发送缓冲积压超过这么多还没发出去，说明对端太慢或链路卡住：断开会话，手机重连后重新同步 */
export const MAX_SEND_BACKLOG_BYTES = 16 * 1024 * 1024;

const FLAG_MORE = 0;
const FLAG_LAST = 1;

/** 承载：一条能收发二进制帧的连接（中继会话或局域网 WebSocket） */
export interface Carrier {
  send(frame: Buffer): void;
  onFrame(cb: (frame: Buffer) => void): void;
  onClose(cb: () => void): void;
  close(): void;
  /** 已交给承载但还没真正发出去的字节数；不提供视为 0 */
  bufferedAmount?(): number;
}

export class SecureChannel {
  private readonly carrier: Carrier;
  private readonly sendState: CipherState;
  private readonly recvState: CipherState;
  private readonly messageListeners: ((message: unknown) => void)[] = [];
  private readonly closeListeners: (() => void)[] = [];
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private closed = false;

  constructor(carrier: Carrier, send: CipherState, recv: CipherState) {
    this.carrier = carrier;
    this.sendState = send;
    this.recvState = recv;
    carrier.onFrame((frame) => this.handleFrame(frame));
    carrier.onClose(() => this.finish());
  }

  send(message: unknown): void {
    if (this.closed) return;
    if ((this.carrier.bufferedAmount?.() ?? 0) > MAX_SEND_BACKLOG_BYTES) {
      this.close();
      return;
    }
    const data = Buffer.from(JSON.stringify(message), 'utf8');
    let offset = 0;
    do {
      const end = Math.min(offset + CHUNK_DATA_BYTES, data.length);
      const flag = end >= data.length ? FLAG_LAST : FLAG_MORE;
      const plain = Buffer.concat([Buffer.from([flag]), data.subarray(offset, end)]);
      this.carrier.send(Buffer.concat([Buffer.from([FRAME_DATA]), this.sendState.encrypt(plain)]));
      offset = end;
    } while (offset < data.length);
  }

  onMessage(cb: (message: unknown) => void): void {
    this.messageListeners.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeListeners.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.finish();
    this.carrier.close();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    this.pendingBytes = 0;
    for (const cb of this.closeListeners) cb();
  }

  private fail(): void {
    this.close();
  }

  private handleFrame(frame: Buffer): void {
    if (this.closed) return;
    if (frame.length < 1 || frame[0] !== FRAME_DATA) {
      this.fail();
      return;
    }
    let plain: Buffer;
    try {
      plain = this.recvState.decrypt(frame.subarray(1));
    } catch {
      this.fail();
      return;
    }
    if (plain.length < 1) {
      this.fail();
      return;
    }
    const flag = plain[0]!;
    if ((flag !== FLAG_MORE && flag !== FLAG_LAST) || plain.length - 1 > CHUNK_DATA_BYTES) {
      this.fail();
      return;
    }
    this.pendingBytes += plain.length - 1;
    if (this.pendingBytes > MAX_APP_MESSAGE_BYTES) {
      this.fail();
      return;
    }
    this.pending.push(plain.subarray(1));
    if (flag === FLAG_MORE) return;

    const whole = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    let message: unknown;
    try {
      message = JSON.parse(whole.toString('utf8'));
    } catch {
      this.fail();
      return;
    }
    for (const cb of this.messageListeners) cb(message);
  }
}
