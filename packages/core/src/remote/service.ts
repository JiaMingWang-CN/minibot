import os from 'node:os';
import type { Kernel } from '../kernel.ts';
import { dataPaths } from '../paths.ts';
import type { KeyCrypto } from '../secrets/store.ts';
import type { Carrier } from './channel.ts';
import { RemoteGateway, type PhoneCompat } from './gateway.ts';
import { LanListener } from './lan-listener.ts';
import { RelayLink } from './relay-link.ts';
import { RemoteStore, type ConfigPatch, type Device, type RemoteConfig } from './store.ts';

export type { Device, RemoteConfig };

export interface RemoteStatus {
  available: boolean;
  config: RemoteConfig;
  hasRelayToken: boolean;
  relay: 'off' | 'connecting' | 'connected' | 'error';
  relayError: string | null;
  lan: 'off' | 'listening' | 'error';
  lanError: string | null;
  devices: (Device & { online: boolean; appVersion: string | null; compat: PhoneCompat })[];
  pairing: { code: string; expiresAt: number } | null;
}

export interface RemoteServiceOptions {
  dataRoot: string;
  crypto: KeyCrypto;
  platform?: NodeJS.Platform;
  /** 测试用：中继重连的起始退避 */
  relayBackoffMs?: number;
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

export class RemoteService {
  private readonly store: RemoteStore;
  private readonly gateway: RemoteGateway;
  private readonly kernel: Kernel;
  private readonly relayBackoffMs: number | undefined;
  private readonly listeners = new Set<() => void>();
  private link: RelayLink | null = null;
  private linkKey: string | null = null;
  private relayState: RemoteStatus['relay'] = 'off';
  private relayError: string | null = null;
  private lanListener: LanListener | null = null;
  private lanKey: number | null = null;
  private lanState: RemoteStatus['lan'] = 'off';
  private lanError: string | null = null;
  private lanFailedKey: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(store: RemoteStore, gateway: RemoteGateway, kernel: Kernel, relayBackoffMs: number | undefined) {
    this.store = store;
    this.kernel = kernel;
    this.gateway = gateway;
    this.relayBackoffMs = relayBackoffMs;
  }

  static async start(kernel: Kernel, o: RemoteServiceOptions): Promise<RemoteService> {
    const store = await RemoteStore.open({
      paths: dataPaths(o.dataRoot),
      crypto: o.crypto,
      ...(o.platform !== undefined ? { platform: o.platform } : {}),
    });
    const gateway = new RemoteGateway(kernel, store, { lanAddresses, appVersion: kernel.version() });
    // 中继口令也登记为密钥：之后任何日志与事件里出现它都会被替换
    const token = store.relayToken();
    if (token !== null) kernel.diag.secrets.add(token);
    const service = new RemoteService(store, gateway, kernel, o.relayBackoffMs);
    gateway.on(() => {
      service.emit();
      void service.reconcile(false);
    });
    await service.reconcile(false);
    return service;
  }

  status(): RemoteStatus {
    const online = new Set(this.gateway.onlineDeviceIds());
    return {
      available: this.store.available(),
      config: this.store.config(),
      hasRelayToken: this.store.relayToken() !== null,
      relay: this.relayState,
      relayError: this.relayError,
      lan: this.lanState,
      lanError: this.lanError,
      devices: this.store.devices().map((d) => {
        const version = this.gateway.deviceVersion(d.id);
        return { ...d, online: online.has(d.id), appVersion: version.appVersion, compat: version.compat };
      }),
      pairing: this.gateway.pairing(),
    };
  }

  hasDevices(): boolean {
    return this.store.devices().length > 0;
  }

  async updateConfig(patch: ConfigPatch): Promise<RemoteStatus> {
    const oldToken = this.store.relayToken();
    await this.store.updateConfig(patch);
    const token = this.store.relayToken();
    if (oldToken !== null && oldToken !== token) this.kernel.diag.secrets.remove(oldToken);
    if (token !== null) this.kernel.diag.secrets.add(token);
    await this.reconcile(true);
    this.emit();
    return this.status();
  }

  startPairing(): RemoteStatus {
    this.gateway.startPairing({ lanAddresses: lanAddresses() });
    void this.reconcile(true);
    return this.status();
  }

  cancelPairing(): RemoteStatus {
    this.gateway.cancelPairing();
    return this.status();
  }

  async revoke(deviceId: string): Promise<RemoteStatus> {
    await this.gateway.revoke(deviceId);
    await this.reconcile(false);
    return this.status();
  }

  on(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.gateway.close();
    await this.queue;
    this.link?.stop();
    this.link = null;
    await this.lanListener?.close();
    this.lanListener = null;
    await this.store.flush().catch(() => {});
    this.listeners.clear();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private accept = (via: 'lan' | 'relay') => (carrier: Carrier) => this.gateway.accept(carrier, via);

  /** 按配置与"是否有设备 / 邀请"启停中继连接与局域网监听 */
  private reconcile(force: boolean): Promise<void> {
    this.queue = this.queue.then(() => this.doReconcile(force)).catch(() => {});
    return this.queue;
  }

  private async doReconcile(force: boolean): Promise<void> {
    if (this.closed) return;
    const active = this.store.available() && (this.store.devices().length > 0 || this.gateway.pairing() !== null);
    const config = this.store.config();
    const token = this.store.relayToken();

    // 中继
    const wantRelay = active && config.relayUrl !== null && token !== null;
    const nextLinkKey = wantRelay ? `${config.relayUrl}\n${token}` : null;
    // 停止重连的链接（口令错误、被顶替）只在用户有动作（改配置、开始配对）时再试一次
    const retryStopped = force && this.link !== null && this.link.isStopped();
    if (nextLinkKey !== this.linkKey || retryStopped) {
      this.link?.stop();
      this.link = null;
      this.linkKey = nextLinkKey;
      this.setRelay('off', null);
      if (wantRelay && config.relayUrl !== null && token !== null) {
        this.link = new RelayLink({
          url: config.relayUrl,
          token,
          identity: this.store.identity(),
          accept: this.accept('relay'),
          onState: (state, error) => this.setRelay(state, error),
          diag: this.kernel.diag,
          ...(this.relayBackoffMs !== undefined ? { initialBackoffMs: this.relayBackoffMs } : {}),
        });
        this.link.start();
      }
    }

    // 局域网
    const wantLan = active && config.lanEnabled;
    const nextLanKey = wantLan ? config.lanPort : null;
    const retryFailed = nextLanKey !== null && this.lanFailedKey === nextLanKey && !force;
    if (nextLanKey !== this.lanKey && !retryFailed) {
      await this.lanListener?.close();
      this.lanListener = null;
      this.lanKey = nextLanKey;
      this.lanFailedKey = null;
      this.setLan('off', null);
      if (nextLanKey !== null) {
        try {
          this.lanListener = await LanListener.start(nextLanKey, this.accept('lan'));
          this.setLan('listening', null);
        } catch (err) {
          this.lanKey = null;
          this.lanFailedKey = nextLanKey;
          const code = (err as NodeJS.ErrnoException).code;
          this.setLan(
            'error',
            code === 'EADDRINUSE' ? `端口 ${nextLanKey} 已被占用` : `局域网监听失败：${(err as Error).message}`,
          );
        }
      }
    } else if (nextLanKey === null && this.lanFailedKey !== null) {
      this.lanFailedKey = null;
      this.setLan('off', null);
    }
  }

  private setRelay(state: RemoteStatus['relay'], error: string | null): void {
    if (this.relayState === state && this.relayError === error) return;
    this.relayState = state;
    this.relayError = error;
    this.emit();
  }

  private setLan(state: RemoteStatus['lan'], error: string | null): void {
    if (this.lanState === state && this.lanError === error) return;
    this.lanState = state;
    this.lanError = error;
    this.emit();
  }
}
