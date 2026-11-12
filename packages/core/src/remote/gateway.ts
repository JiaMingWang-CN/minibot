import { Buffer } from 'node:buffer';
import { dispatchApi, HttpError, REMOTE_FORBIDDEN, type ApiRequest, type ApiResponse } from '../server/dispatch.ts';
import type { Kernel } from '../kernel.ts';
import { KernelError } from '../kernel.ts';
import { FRAME_KK, FRAME_PAIR, SecureChannel, type Carrier } from './channel.ts';
import { isRemoteAllowed } from './allowlist.ts';
import { createHandshake, type Handshake } from './noise.ts';
import { createOffer, MAX_PAIRING_FAILURES, PAIRING_TTL_MS, type ActiveOffer, type PairingOffer } from './pairing.ts';
import { deviceIdOf, type RemoteStore } from './store.ts';

// 远程网关：接住一条承载，完成 Noise 握手（配对 / 日常），之后在加密信道里
// 按白名单转发 HTTP 风格请求、推送内核事件、接收中断 / 审批指令。
//
// 握手帧格式（每个握手消息一帧）：
//   配对 手机→电脑：[0x01][msg1]，电脑→手机：[0x01][msg2]，手机→电脑：[0x01][msg3]
//   日常 手机→电脑：[0x02][16 字节 deviceId][msg1]，电脑→手机：[0x02][msg2]

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEVICE_ID_BYTES = 16;
const MAX_MESSAGE_BODY_BYTES = 32 * 1024 * 1024;

export type { PairingOffer };

interface Session {
  channel: SecureChannel;
  deviceId: string;
  unsubscribe: () => void;
}

export interface GatewayOptions {
  now?: () => number;
  handshakeTimeoutMs?: number;
  /** 当前的局域网地址；ready 里带给手机，让电脑换 IP 后手机能自己更新 */
  lanAddresses?: () => string[];
}

export class RemoteGateway {
  private readonly kernel: Kernel;
  private readonly store: RemoteStore;
  private readonly now: () => number;
  private readonly handshakeTimeoutMs: number;
  private readonly lanAddresses: () => string[];
  private offer: ActiveOffer | null = null;
  private offerTimer: NodeJS.Timeout | null = null;
  private readonly sessions = new Map<string, Set<Session>>();
  private readonly carriers = new Set<Carrier>();
  private readonly listeners = new Set<() => void>();
  private closed = false;

  constructor(kernel: Kernel, store: RemoteStore, o: GatewayOptions = {}) {
    this.kernel = kernel;
    this.store = store;
    this.now = o.now ?? Date.now;
    this.handshakeTimeoutMs = o.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.lanAddresses = o.lanAddresses ?? (() => []);
  }

  // —— 配对邀请 ——

  startPairing(extra: { lanAddresses: string[] }): PairingOffer {
    if (!this.store.available()) throw new KernelError('invalid', '当前系统没有可用的密钥库，无法使用手机功能');
    const config = this.store.config();
    this.clearOffer();
    const offer = createOffer(this.now(), {
      relay: config.relayUrl,
      token: this.store.relayToken(),
      publicKey: this.store.identity().publicKey,
      name: config.pcName,
      lan: extra.lanAddresses,
      port: config.lanPort,
    });
    this.offer = offer;
    this.offerTimer = setTimeout(() => {
      if (this.offer === offer) {
        this.offer = null;
        this.offerTimer = null;
        this.notify();
      }
    }, PAIRING_TTL_MS + 50);
    this.offerTimer.unref();
    this.notify();
    return { code: offer.code, expiresAt: offer.expiresAt };
  }

  cancelPairing(): void {
    if (this.offer === null) return;
    this.clearOffer();
    this.notify();
  }

  pairing(): PairingOffer | null {
    const offer = this.validOffer();
    return offer === null ? null : { code: offer.code, expiresAt: offer.expiresAt };
  }

  private clearOffer(): void {
    this.offer = null;
    if (this.offerTimer !== null) clearTimeout(this.offerTimer);
    this.offerTimer = null;
  }

  private validOffer(): ActiveOffer | null {
    const offer = this.offer;
    if (offer === null) return null;
    if (this.now() >= offer.expiresAt || offer.failures >= MAX_PAIRING_FAILURES) return null;
    return offer;
  }

  // —— 设备与会话 ——

  async revoke(deviceId: string): Promise<boolean> {
    const removed = await this.store.removeDevice(deviceId);
    for (const session of [...(this.sessions.get(deviceId) ?? [])]) session.channel.close();
    this.notify();
    return removed;
  }

  onlineDeviceIds(): string[] {
    return [...this.sessions.entries()].filter(([, set]) => set.size > 0).map(([id]) => id);
  }

  on(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  close(): void {
    this.closed = true;
    this.clearOffer();
    for (const carrier of [...this.carriers]) carrier.close();
    this.carriers.clear();
  }

  // —— 接入 ——

  accept(carrier: Carrier, via: 'lan' | 'relay'): void {
    if (this.closed || !this.store.available()) {
      carrier.close();
      return;
    }
    this.carriers.add(carrier);
    const timer = setTimeout(() => carrier.close(), this.handshakeTimeoutMs);
    timer.unref();
    carrier.onClose(() => {
      carrierClosed = true;
      clearTimeout(timer);
      this.carriers.delete(carrier);
    });

    let handshake: Handshake | null = null;
    let mode: 'pair' | 'kk' | null = null;
    let offer: ActiveOffer | null = null;
    let finished = false;
    let carrierClosed = false;

    const finish = (hs: Handshake, newDeviceId: string, pairedName: string | null): void => {
      finished = true;
      clearTimeout(timer);
      const { send, recv } = hs.split();
      const channel = new SecureChannel(carrier, send, recv);
      this.startSession(channel, newDeviceId, via, pairedName);
    };

    const diag = this.kernel.diag;
    const fail = (reason: string): void => {
      if (mode === 'pair') {
        diag.write('warn', 'remote', 'pair.failed', { via, reason }, { kind: 'error', name: 'remote.pair', data: { via, reason } });
      } else {
        diag.write('warn', 'remote', 'handshake.failed', { via, reason });
      }
      if (mode === 'pair' && offer !== null) {
        offer.failures += 1;
        if (offer.failures >= MAX_PAIRING_FAILURES && this.offer === offer) this.notify();
      }
      carrier.close();
    };

    carrier.onFrame((frame) => {
      if (finished) return;
      try {
        if (handshake === null) {
          const kind = frame[0];
          if (kind === FRAME_PAIR) {
            offer = this.validOffer();
            if (offer === null) {
              diag.write('warn', 'remote', 'pair.failed', { via, reason: 'no_offer' }, { kind: 'error', name: 'remote.pair', data: { via, reason: 'no_offer' } });
              carrier.close();
              return;
            }
            mode = 'pair';
            handshake = createHandshake({
              pattern: 'XXpsk3',
              initiator: false,
              s: this.store.identity(),
              psk: offer.psk,
            });
            handshake.readMessage(frame.subarray(1));
            const name = Buffer.from(JSON.stringify({ pcName: this.store.config().pcName }), 'utf8');
            carrier.send(Buffer.concat([Buffer.from([FRAME_PAIR]), handshake.writeMessage(name)]));
            return;
          }
          if (kind === FRAME_KK) {
            if (frame.length < 1 + DEVICE_ID_BYTES) {
              carrier.close();
              return;
            }
            const id = frame.subarray(1, 1 + DEVICE_ID_BYTES).toString('hex');
            const device = this.store.findDevice(id);
            if (device === null) {
              diag.write('info', 'remote', 'handshake.rejected', { via, reason: 'unknown_device' });
              carrier.close();
              return;
            }
            mode = 'kk';
            handshake = createHandshake({
              pattern: 'KK',
              initiator: false,
              s: this.store.identity(),
              rs: Buffer.from(device.publicKey, 'base64url'),
            });
            handshake.readMessage(frame.subarray(1 + DEVICE_ID_BYTES));
            carrier.send(Buffer.concat([Buffer.from([FRAME_KK]), handshake.writeMessage(Buffer.alloc(0))]));
            finish(handshake, id, null);
            return;
          }
          carrier.close();
          return;
        }

        // 配对的第三条握手消息
        if (mode !== 'pair' || frame[0] !== FRAME_PAIR || offer === null) {
          carrier.close();
          return;
        }
        const payload = handshake.readMessage(frame.subarray(1));
        if (this.offer !== offer || this.validOffer() === null) {
          carrier.close();
          return;
        }
        const remote = handshake.remoteStatic();
        if (remote === null) throw new Error('缺少对方公钥');
        const info = JSON.parse(payload.toString('utf8')) as { deviceName?: unknown };
        const deviceName = typeof info.deviceName === 'string' && info.deviceName.trim().length > 0 ? info.deviceName : '手机';
        const device = handshake;
        // 邀请一次性：先作废，再落盘设备
        this.clearOffer();
        void this.store
          .addDevice(deviceName, remote)
          .then(() => {
            diag.write('info', 'remote', 'pair.ok', { via });
            if (!carrierClosed) finish(device, deviceIdOf(remote), deviceName);
            // 手机已经断开：设备已保存、邀请已作废，仍要让界面知道
            else this.notify();
          })
          .catch(() => {
            diag.write('error', 'remote', 'pair.failed', { via, reason: 'store' }, { kind: 'error', name: 'remote.pair', data: { via, reason: 'store' } });
            this.notify();
            carrier.close();
          });
        finished = true;
      } catch {
        fail('handshake');
      }
    });
  }

  private startSession(channel: SecureChannel, deviceId: string, via: 'lan' | 'relay', pairedName: string | null): void {
    const session: Session = { channel, deviceId, unsubscribe: () => {} };
    let set = this.sessions.get(deviceId);
    if (set === undefined) {
      set = new Set();
      this.sessions.set(deviceId, set);
    }
    set.add(session);

    channel.onClose(() => {
      session.unsubscribe();
      set.delete(session);
      if (set.size === 0) this.sessions.delete(deviceId);
      this.notify();
    });
    channel.onMessage((message) => this.handleMessage(channel, message));

    void this.store.touch(deviceId, via).catch(() => {});
    if (pairedName !== null) channel.send({ t: 'paired', deviceId });
    const config = this.store.config();
    channel.send({
      t: 'ready',
      pcName: config.pcName,
      lan: config.lanEnabled ? this.lanAddresses() : [],
      port: config.lanPort,
    });
    session.unsubscribe = this.kernel.on((event) => {
      if (event.type === 'memory_changed') return;
      channel.send({ t: 'evt', event });
    });
    this.notify();
  }

  // —— 会话内消息 ——

  private handleMessage(channel: SecureChannel, message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const m = message as Record<string, unknown>;
    if (m['t'] === 'req') {
      void this.handleRequest(channel, m);
    } else if (m['t'] === 'ctl') {
      this.handleControl(m['msg']);
    }
  }

  private handleControl(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const msg = raw as Record<string, unknown>;
    if (msg['type'] === 'abort' && typeof msg['threadId'] === 'string') {
      this.kernel.abort(msg['threadId']);
    } else if (msg['type'] === 'approval' && typeof msg['id'] === 'string' && typeof msg['approve'] === 'boolean') {
      // 审批只经内核这一处生效
      this.kernel.respondApproval(msg['id'], msg['approve'], msg['always'] === true);
    }
  }

  private async handleRequest(channel: SecureChannel, m: Record<string, unknown>): Promise<void> {
    const id = m['id'];
    if (typeof id !== 'string' && typeof id !== 'number') return;
    const reply = (response: ApiResponse): void => {
      if ('json' in response) {
        channel.send({ t: 'res', id, status: response.status, body: response.json });
      } else {
        channel.send({
          t: 'res',
          id,
          status: response.status,
          bytes: response.bytes.toString('base64'),
          contentType: response.contentType,
        });
      }
    };

    const method = m['method'];
    const rawPath = m['path'];
    let url: URL | null = null;
    if (typeof method === 'string' && typeof rawPath === 'string' && rawPath.startsWith('/') && !rawPath.startsWith('//')) {
      try {
        const parsed = new URL(rawPath, 'http://remote');
        if (parsed.origin === 'http://remote') url = parsed;
      } catch {
        url = null;
      }
    }
    if (url === null || typeof method !== 'string') {
      reply({ status: 400, json: { error: { code: 'invalid', message: '请求格式不正确' } } });
      return;
    }
    if (!isRemoteAllowed(method, url.pathname)) {
      reply(REMOTE_FORBIDDEN);
      return;
    }

    const req: ApiRequest = {
      method,
      url,
      readBody: async (maxBytes) => {
        const body = m['body'];
        if (body === undefined) throw new KernelError('invalid', '请求体为空');
        const limit = Math.min(maxBytes, MAX_MESSAGE_BODY_BYTES);
        if (Buffer.byteLength(JSON.stringify(body)) > limit) {
          throw new HttpError(413, 'payload_too_large', `请求体超过 ${Math.round(maxBytes / 1024 / 1024)}MB`);
        }
        return body;
      },
    };
    reply(await dispatchApi(this.kernel, req));
  }
}
