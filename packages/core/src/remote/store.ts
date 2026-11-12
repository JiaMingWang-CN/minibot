import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { atomicWriteFile } from '../fs/atomic-write.ts';
import { KernelError } from '../kernel.ts';
import type { DataPaths } from '../paths.ts';
import type { KeyCrypto } from '../secrets/store.ts';
import { generateKeyPair, publicKeyOf, type KeyPair } from './noise.ts';

export interface RemoteConfig {
  relayUrl: string | null;
  lanEnabled: boolean;
  lanPort: number;
  pcName: string;
}

export interface Device {
  id: string;
  name: string;
  /** base64url，32 字节 X25519 公钥 */
  publicKey: string;
  pairedAt: number;
  lastSeenAt: number | null;
  lastVia: 'lan' | 'relay' | null;
}

export type ConfigPatch = Partial<RemoteConfig> & { relayToken?: string | null };

const TOUCH_FLUSH_INTERVAL_MS = 60_000;
const NO_KEYSTORE = '当前系统没有可用的密钥库，无法使用手机功能';

export function deviceIdOf(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest().subarray(0, 16).toString('hex');
}

function cleanName(raw: string): string {
  const name = raw.trim().slice(0, 40);
  if (name.length === 0) throw new KernelError('invalid', '名称不能为空');
  return name;
}

function defaultConfig(): RemoteConfig {
  const host = os.hostname().trim().slice(0, 40);
  return { relayUrl: null, lanEnabled: true, lanPort: 47821, pcName: host.length > 0 ? host : 'minibot' };
}

interface KeyFile {
  privateKey: string;
  publicKey: string;
  relayToken: string | null;
}

export class RemoteStore {
  private readonly paths: DataPaths;
  private readonly crypto: KeyCrypto;
  private readonly isAvailable: boolean;
  private readonly now: () => number;
  private cfg: RemoteConfig = defaultConfig();
  private deviceList: Device[] = [];
  private keyFile: KeyFile | null = null;
  private usable: boolean;
  private lastFlush = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(o: { paths: DataPaths; crypto: KeyCrypto; platform: NodeJS.Platform; now: () => number }) {
    this.paths = o.paths;
    this.crypto = o.crypto;
    this.now = o.now;
    this.isAvailable = o.platform !== 'linux' || o.crypto.backend() !== 'basic_text';
    this.usable = this.isAvailable;
  }

  static async open(o: {
    paths: DataPaths;
    crypto: KeyCrypto;
    platform?: NodeJS.Platform;
    now?: () => number;
  }): Promise<RemoteStore> {
    const store = new RemoteStore({
      paths: o.paths,
      crypto: o.crypto,
      platform: o.platform ?? process.platform,
      now: o.now ?? Date.now,
    });
    await store.load();
    return store;
  }

  private async load(): Promise<void> {
    await this.loadConfig();
    await this.loadDevices();
    if (this.isAvailable) await this.loadKey();
  }

  private async readJson(file: string): Promise<unknown> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return null;
    }
  }

  private async loadConfig(): Promise<void> {
    const raw = await this.readJson(this.paths.remoteJson);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
    const r = raw as Record<string, unknown>;
    const base = defaultConfig();
    this.cfg = {
      relayUrl: typeof r['relayUrl'] === 'string' && /^wss?:\/\//.test(r['relayUrl']) ? r['relayUrl'] : null,
      lanEnabled: typeof r['lanEnabled'] === 'boolean' ? r['lanEnabled'] : base.lanEnabled,
      lanPort:
        typeof r['lanPort'] === 'number' && Number.isInteger(r['lanPort']) && r['lanPort'] >= 1024 && r['lanPort'] <= 65535
          ? r['lanPort']
          : base.lanPort,
      pcName: typeof r['pcName'] === 'string' && r['pcName'].trim().length > 0 ? r['pcName'].trim().slice(0, 40) : base.pcName,
    };
  }

  private async loadDevices(): Promise<void> {
    const raw = await this.readJson(this.paths.devicesJson);
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const d = item as Record<string, unknown>;
      if (typeof d['id'] !== 'string' || typeof d['name'] !== 'string' || typeof d['publicKey'] !== 'string') continue;
      this.deviceList.push({
        id: d['id'],
        name: d['name'],
        publicKey: d['publicKey'],
        pairedAt: typeof d['pairedAt'] === 'number' ? d['pairedAt'] : 0,
        lastSeenAt: typeof d['lastSeenAt'] === 'number' ? d['lastSeenAt'] : null,
        lastVia: d['lastVia'] === 'lan' || d['lastVia'] === 'relay' ? d['lastVia'] : null,
      });
    }
  }

  private async loadKey(): Promise<void> {
    let buf: Buffer;
    try {
      buf = await fs.readFile(this.paths.remoteKey);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.usable = false;
        return;
      }
      const pair = generateKeyPair();
      this.keyFile = {
        privateKey: pair.privateKey.toString('base64url'),
        publicKey: pair.publicKey.toString('base64url'),
        relayToken: null,
      };
      try {
        await this.writeKey();
      } catch {
        // 加密或写盘失败：私钥没存下来就不能用（每次启动换身份会让已配对手机全部失效）
        this.keyFile = null;
        this.usable = false;
      }
      return;
    }
    try {
      const parsed = JSON.parse(this.crypto.decrypt(buf)) as Partial<KeyFile>;
      if (typeof parsed.privateKey !== 'string') throw new Error('bad');
      const privateKey = Buffer.from(parsed.privateKey, 'base64url');
      if (privateKey.length !== 32) throw new Error('bad');
      this.keyFile = {
        privateKey: parsed.privateKey,
        publicKey: publicKeyOf(privateKey).toString('base64url'),
        relayToken: typeof parsed.relayToken === 'string' ? parsed.relayToken : null,
      };
    } catch {
      // 无法解密：不覆盖原文件，手机功能不可用
      this.usable = false;
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private writeKey(): Promise<void> {
    const key = this.keyFile!;
    return this.enqueue(() => atomicWriteFile(this.paths.remoteKey, this.crypto.encrypt(JSON.stringify(key))));
  }

  private writeConfig(): Promise<void> {
    return this.enqueue(() => atomicWriteFile(this.paths.remoteJson, `${JSON.stringify(this.cfg, null, 2)}\n`));
  }

  private writeDevices(): Promise<void> {
    return this.enqueue(() =>
      atomicWriteFile(this.paths.devicesJson, `${JSON.stringify(this.deviceList, null, 2)}\n`),
    );
  }

  available(): boolean {
    return this.usable && this.keyFile !== null;
  }

  private requireKey(): KeyFile {
    if (!this.available() || this.keyFile === null) throw new KernelError('invalid', NO_KEYSTORE);
    return this.keyFile;
  }

  identity(): KeyPair {
    const key = this.requireKey();
    return {
      privateKey: Buffer.from(key.privateKey, 'base64url'),
      publicKey: Buffer.from(key.publicKey, 'base64url'),
    };
  }

  routeId(): string {
    return deviceIdOf(this.identity().publicKey);
  }

  config(): RemoteConfig {
    return { ...this.cfg };
  }

  relayToken(): string | null {
    return this.keyFile?.relayToken ?? null;
  }

  async updateConfig(patch: ConfigPatch): Promise<void> {
    const next = { ...this.cfg };
    if (patch.relayUrl !== undefined) {
      if (patch.relayUrl === null || patch.relayUrl.trim().length === 0) {
        next.relayUrl = null;
      } else {
        const url = patch.relayUrl.trim();
        if (!/^wss?:\/\//.test(url)) throw new KernelError('invalid', '中继地址必须以 ws:// 或 wss:// 开头');
        next.relayUrl = url;
      }
    }
    if (patch.lanEnabled !== undefined) next.lanEnabled = patch.lanEnabled;
    if (patch.lanPort !== undefined) {
      if (!Number.isInteger(patch.lanPort) || patch.lanPort < 1024 || patch.lanPort > 65535) {
        throw new KernelError('invalid', '端口必须是 1024 到 65535 之间的整数');
      }
      next.lanPort = patch.lanPort;
    }
    if (patch.pcName !== undefined) next.pcName = cleanName(patch.pcName);
    if (patch.relayToken !== undefined) this.requireKey();

    this.cfg = next;
    await this.writeConfig();
    if (patch.relayToken !== undefined) {
      this.keyFile!.relayToken = patch.relayToken === null || patch.relayToken.length === 0 ? null : patch.relayToken;
      await this.writeKey();
    }
  }

  devices(): Device[] {
    return this.deviceList.map((d) => ({ ...d }));
  }

  findDevice(id: string): Device | null {
    const found = this.deviceList.find((d) => d.id === id);
    return found === undefined ? null : { ...found };
  }

  async addDevice(name: string, publicKey: Buffer): Promise<Device> {
    this.requireKey();
    if (publicKey.length !== 32) throw new KernelError('invalid', '设备公钥无效');
    const id = deviceIdOf(publicKey);
    const device: Device = {
      id,
      name: cleanName(name),
      publicKey: publicKey.toString('base64url'),
      pairedAt: this.now(),
      lastSeenAt: null,
      lastVia: null,
    };
    this.deviceList = [...this.deviceList.filter((d) => d.id !== id), device];
    await this.writeDevices();
    return { ...device };
  }

  async removeDevice(id: string): Promise<boolean> {
    const before = this.deviceList.length;
    this.deviceList = this.deviceList.filter((d) => d.id !== id);
    if (this.deviceList.length === before) return false;
    this.lastFlush.delete(id);
    await this.writeDevices();
    return true;
  }

  async touch(id: string, via: 'lan' | 'relay'): Promise<void> {
    const device = this.deviceList.find((d) => d.id === id);
    if (device === undefined) return;
    const t = this.now();
    device.lastSeenAt = t;
    device.lastVia = via;
    const last = this.lastFlush.get(id);
    if (last !== undefined && t - last < TOUCH_FLUSH_INTERVAL_MS) return;
    this.lastFlush.set(id, t);
    await this.writeDevices();
  }

  /** 把节流期内只在内存里的最后在线时间写盘 */
  async flush(): Promise<void> {
    await this.writeDevices();
  }
}
