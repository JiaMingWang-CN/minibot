import { promises as fs } from 'node:fs';
import { atomicWriteFile } from '../fs/atomic-write.ts';
import { SecretSet } from './redact.ts';

export interface KeyCrypto {
  backend(): string;
  encrypt(plain: string): Buffer;
  decrypt(buf: Buffer): string;
}

export class SecretPersistError extends Error {
  constructor(message = '当前系统没有可用的密钥库，无法保存 API Key') {
    super(message);
    this.name = 'SecretPersistError';
  }
}

export interface SecretStoreOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export class SecretStore {
  private file: string;
  private crypto: KeyCrypto;
  private secrets: SecretSet;
  private platform: NodeJS.Platform;
  private env: NodeJS.ProcessEnv;
  private data = new Map<string, string>();
  private loaded = false;
  private unreadable = false;

  constructor(file: string, crypto: KeyCrypto, secrets: SecretSet, opts: SecretStoreOptions = {}) {
    this.file = file;
    this.crypto = crypto;
    this.secrets = secrets;
    this.platform = opts.platform ?? process.platform;
    this.env = opts.env ?? process.env;
  }

  async load(): Promise<void> {
    let buf: Buffer;
    try {
      buf = await fs.readFile(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.loaded = true;
        return;
      }
      // 读失败不算加载完成：否则之后的 set() 会把没读到的原文件直接覆盖
      throw err;
    }
    this.loaded = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.crypto.decrypt(buf));
    } catch {
      // 解密失败（如系统密钥库被重置）：不阻止启动，保留原文件，等用户重新填写 Key
      this.unreadable = true;
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.unreadable = true;
      return;
    }
    for (const [providerId, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') continue;
      this.data.set(providerId, value);
      this.register(providerId, value);
    }
  }

  /** 登记脱敏：整段值；mcp:*:oauth 的值是 JSON，其中的 token / secret 字符串字段还要单独登记 */
  private register(key: string, value: string): void {
    this.secrets.add(value);
    if (!/^mcp:.+:oauth$/.test(key)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return;
    }
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      for (const [name, v] of Object.entries(node)) {
        if (typeof v === 'string') {
          if (/token|secret/i.test(name) && name !== 'token_type') this.secrets.add(v);
        } else {
          walk(v);
        }
      }
    };
    walk(parsed);
  }

  /** secrets.bin 存在但无法解密 */
  isUnreadable(): boolean {
    return this.unreadable;
  }

  /** 把这些环境变量里的 Key 加入脱敏集合（不落盘） */
  registerEnv(names: string[]): void {
    for (const name of names) {
      const value = this.env[name];
      if (value !== undefined && value.length > 0) this.secrets.add(value);
    }
  }

  canPersist(): boolean {
    return this.platform !== 'linux' || this.crypto.backend() !== 'basic_text';
  }

  async set(providerId: string, key: string): Promise<void> {
    if (!this.canPersist()) throw new SecretPersistError();
    await this.ensureLoaded();
    this.data.set(providerId, key);
    await this.flush();
    this.register(providerId, key);
  }

  async delete(providerId: string): Promise<void> {
    await this.ensureLoaded();
    const removed = this.data.get(providerId);
    if (removed === undefined) return;
    this.data.delete(providerId);
    await this.flush();
    if (![...this.data.values()].includes(removed)) this.secrets.remove(removed);
  }

  get(providerId: string, envName?: string): string | null {
    if (envName !== undefined) {
      const fromEnv = this.env[envName];
      if (fromEnv !== undefined && fromEnv.length > 0) {
        this.secrets.add(fromEnv);
        return fromEnv;
      }
    }
    return this.data.get(providerId) ?? null;
  }

  /** 已存的全部键名（不含值） */
  keys(): string[] {
    return [...this.data.keys()];
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async flush(): Promise<void> {
    if (this.unreadable) {
      // 覆盖前先把无法解密的旧文件改名备份，不直接丢弃
      try {
        await fs.rename(this.file, `${this.file}.unreadable-${Date.now()}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      this.unreadable = false;
    }
    const plain = JSON.stringify(Object.fromEntries(this.data));
    await atomicWriteFile(this.file, this.crypto.encrypt(plain), undefined, 0o600);
  }
}
