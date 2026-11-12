import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';

// Noise 协议框架（规范第 5 章）的最小实现，只覆盖本项目用到的两种模式：
// Noise_XXpsk3_25519_ChaChaPoly_SHA256（配对）与 Noise_KK_25519_ChaChaPoly_SHA256（日常）。

export interface KeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

export type NoisePattern = 'XXpsk3' | 'KK';

export interface CipherState {
  encrypt(plain: Buffer): Buffer;
  decrypt(cipher: Buffer): Buffer;
}

export interface Handshake {
  writeMessage(payload: Buffer): Buffer;
  readMessage(message: Buffer): Buffer;
  isComplete(): boolean;
  remoteStatic(): Buffer | null;
  handshakeHash(): Buffer;
  split(): { send: CipherState; recv: CipherState };
}

export interface HandshakeOptions {
  pattern: NoisePattern;
  initiator: boolean;
  s: KeyPair;
  rs?: Buffer;
  psk?: Buffer;
  /** 仅供测试向量注入固定的临时密钥 */
  e?: KeyPair;
  /** 默认 `minibot-remote/1` */
  prologue?: Buffer;
}

export const PROLOGUE = Buffer.from('minibot-remote/1', 'utf8');
const DH_LEN = 32;
const TAG_LEN = 16;
const HASH_LEN = 32;
export const MAX_NOISE_MESSAGE = 65535;

const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function privateKeyObject(raw: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
}

function publicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(-DH_LEN)),
    privateKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-DH_LEN)),
  };
}

/** 由 32 字节私钥推出公钥 */
export function publicKeyOf(privateKey: Buffer): Buffer {
  const pub = createPublicKey(privateKeyObject(privateKey));
  return Buffer.from(pub.export({ type: 'spki', format: 'der' }).subarray(-DH_LEN));
}

/** X25519：32 字节私钥与对方 32 字节公钥的共享值 */
export function x25519(priv: Buffer, pub: Buffer): Buffer {
  return dh(priv, pub);
}

function dh(priv: Buffer, pub: Buffer): Buffer {
  return diffieHellman({ privateKey: privateKeyObject(priv), publicKey: publicKeyObject(pub) });
}

function hash(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** Noise HKDF：输出 2 或 3 段 */
function hkdf(chainingKey: Buffer, ikm: Buffer, outputs: 2 | 3): Buffer[] {
  const temp = hmac(chainingKey, ikm);
  const out1 = hmac(temp, Buffer.from([1]));
  const out2 = hmac(temp, Buffer.concat([out1, Buffer.from([2])]));
  if (outputs === 2) return [out1, out2];
  const out3 = hmac(temp, Buffer.concat([out2, Buffer.from([3])]));
  return [out1, out2, out3];
}

function nonceBytes(n: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(n, 4);
  return nonce;
}

class Cipher implements CipherState {
  private key: Buffer | null = null;
  private n = 0n;

  initializeKey(key: Buffer | null): void {
    this.key = key;
    this.n = 0n;
  }

  hasKey(): boolean {
    return this.key !== null;
  }

  encryptWithAd(ad: Buffer, plain: Buffer): Buffer {
    if (this.key === null) return plain;
    const cipher = createCipheriv('chacha20-poly1305', this.key, nonceBytes(this.n), { authTagLength: TAG_LEN });
    cipher.setAAD(ad, { plaintextLength: plain.length });
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    this.n += 1n;
    return Buffer.concat([body, cipher.getAuthTag()]);
  }

  decryptWithAd(ad: Buffer, data: Buffer): Buffer {
    if (this.key === null) return data;
    if (data.length < TAG_LEN) throw new Error('密文过短');
    const body = data.subarray(0, data.length - TAG_LEN);
    const tag = data.subarray(data.length - TAG_LEN);
    const decipher = createDecipheriv('chacha20-poly1305', this.key, nonceBytes(this.n), {
      authTagLength: TAG_LEN,
    });
    decipher.setAAD(ad, { plaintextLength: body.length });
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]);
    this.n += 1n;
    return plain;
  }

  encrypt(plain: Buffer): Buffer {
    if (this.key === null) throw new Error('密钥未就绪');
    return this.encryptWithAd(Buffer.alloc(0), plain);
  }

  decrypt(cipher: Buffer): Buffer {
    if (this.key === null) throw new Error('密钥未就绪');
    return this.decryptWithAd(Buffer.alloc(0), cipher);
  }
}

type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss' | 'psk';

interface PatternDef {
  name: string;
  psk: boolean;
  /** 预消息：发起方 / 响应方各自是否已知对方的静态公钥 */
  preInitiator: boolean;
  preResponder: boolean;
  messages: Token[][];
}

const PATTERNS: Record<NoisePattern, PatternDef> = {
  XXpsk3: {
    name: 'Noise_XXpsk3_25519_ChaChaPoly_SHA256',
    psk: true,
    preInitiator: false,
    preResponder: false,
    messages: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se', 'psk']],
  },
  KK: {
    name: 'Noise_KK_25519_ChaChaPoly_SHA256',
    psk: false,
    preInitiator: true,
    preResponder: true,
    messages: [
      ['e', 'es', 'ss'],
      ['e', 'ee', 'se'],
    ],
  },
};

class HandshakeState implements Handshake {
  private readonly def: PatternDef;
  private readonly initiator: boolean;
  private readonly s: KeyPair;
  private rs: Buffer | null;
  private e: KeyPair | null;
  private re: Buffer | null = null;
  private readonly psk: Buffer | null;
  private readonly cipher = new Cipher();
  private ck: Buffer;
  private h: Buffer;
  private index = 0;
  private complete = false;

  constructor(o: HandshakeOptions) {
    this.def = PATTERNS[o.pattern];
    this.initiator = o.initiator;
    this.s = o.s;
    this.rs = o.rs ?? null;
    this.e = o.e ?? null;
    this.psk = o.psk ?? null;
    if (this.def.psk && (this.psk === null || this.psk.length !== 32)) throw new Error('需要 32 字节 psk');
    if ((this.def.preInitiator || this.def.preResponder) && this.rs === null) {
      throw new Error('需要对方的静态公钥');
    }

    const name = Buffer.from(this.def.name, 'utf8');
    this.h = name.length <= HASH_LEN ? Buffer.concat([name, Buffer.alloc(HASH_LEN - name.length)]) : hash(name);
    this.ck = this.h;
    this.mixHash(o.prologue ?? PROLOGUE);
    // 预消息：先发起方、后响应方的静态公钥
    if (this.def.preInitiator) this.mixHash(this.initiator ? this.s.publicKey : this.rs!);
    if (this.def.preResponder) this.mixHash(this.initiator ? this.rs! : this.s.publicKey);
  }

  private mixHash(data: Buffer): void {
    this.h = hash(Buffer.concat([this.h, data]));
  }

  private mixKey(ikm: Buffer): void {
    const [ck, k] = hkdf(this.ck, ikm, 2) as [Buffer, Buffer];
    this.ck = ck;
    this.cipher.initializeKey(k);
  }

  private mixKeyAndHash(ikm: Buffer): void {
    const [ck, tempH, tempK] = hkdf(this.ck, ikm, 3) as [Buffer, Buffer, Buffer];
    this.ck = ck;
    this.mixHash(tempH);
    this.cipher.initializeKey(tempK);
  }

  private encryptAndHash(plain: Buffer): Buffer {
    const out = this.cipher.encryptWithAd(this.h, plain);
    this.mixHash(out);
    return out;
  }

  private decryptAndHash(data: Buffer): Buffer {
    const out = this.cipher.decryptWithAd(this.h, data);
    this.mixHash(data);
    return out;
  }

  /** 本方是否轮到写第 index 条消息 */
  private myTurn(): boolean {
    return this.initiator === (this.index % 2 === 0);
  }

  private doDh(token: 'ee' | 'es' | 'se' | 'ss'): Buffer {
    const need = (v: Buffer | null): Buffer => {
      if (v === null) throw new Error('握手状态不完整');
      return v;
    };
    const ePriv = (): Buffer => need(this.e?.privateKey ?? null);
    if (token === 'ee') return dh(ePriv(), need(this.re));
    if (token === 'ss') return dh(this.s.privateKey, need(this.rs));
    // es：发起方的 e 与响应方的 s；se：发起方的 s 与响应方的 e
    if (token === 'es') {
      return this.initiator ? dh(ePriv(), need(this.rs)) : dh(this.s.privateKey, need(this.re));
    }
    return this.initiator ? dh(this.s.privateKey, need(this.re)) : dh(ePriv(), need(this.rs));
  }

  writeMessage(payload: Buffer): Buffer {
    if (this.complete || !this.myTurn()) throw new Error('现在不该写握手消息');
    const parts: Buffer[] = [];
    for (const token of this.def.messages[this.index]!) {
      if (token === 'e') {
        this.e ??= generateKeyPair();
        parts.push(this.e.publicKey);
        this.mixHash(this.e.publicKey);
        if (this.def.psk) this.mixKey(this.e.publicKey);
      } else if (token === 's') {
        parts.push(this.encryptAndHash(this.s.publicKey));
      } else if (token === 'psk') {
        this.mixKeyAndHash(this.psk!);
      } else {
        this.mixKey(this.doDh(token));
      }
    }
    parts.push(this.encryptAndHash(payload));
    const message = Buffer.concat(parts);
    if (message.length > MAX_NOISE_MESSAGE) throw new Error('握手消息过长');
    this.advance();
    return message;
  }

  readMessage(message: Buffer): Buffer {
    if (this.complete || this.myTurn()) throw new Error('现在不该读握手消息');
    if (message.length > MAX_NOISE_MESSAGE) throw new Error('握手消息过长');
    let offset = 0;
    const take = (n: number): Buffer => {
      if (offset + n > message.length) throw new Error('握手消息过短');
      const part = message.subarray(offset, offset + n);
      offset += n;
      return part;
    };
    for (const token of this.def.messages[this.index]!) {
      if (token === 'e') {
        this.re = Buffer.from(take(DH_LEN));
        this.mixHash(this.re);
        if (this.def.psk) this.mixKey(this.re);
      } else if (token === 's') {
        const len = this.cipher.hasKey() ? DH_LEN + TAG_LEN : DH_LEN;
        this.rs = Buffer.from(this.decryptAndHash(take(len)));
      } else if (token === 'psk') {
        this.mixKeyAndHash(this.psk!);
      } else {
        this.mixKey(this.doDh(token));
      }
    }
    const payload = this.decryptAndHash(message.subarray(offset));
    this.advance();
    return Buffer.from(payload);
  }

  private advance(): void {
    this.index += 1;
    if (this.index === this.def.messages.length) this.complete = true;
  }

  isComplete(): boolean {
    return this.complete;
  }

  remoteStatic(): Buffer | null {
    return this.rs;
  }

  handshakeHash(): Buffer {
    return this.h;
  }

  split(): { send: CipherState; recv: CipherState } {
    if (!this.complete) throw new Error('握手尚未完成');
    const [k1, k2] = hkdf(this.ck, Buffer.alloc(0), 2) as [Buffer, Buffer];
    const c1 = new Cipher();
    const c2 = new Cipher();
    c1.initializeKey(k1);
    c2.initializeKey(k2);
    return this.initiator ? { send: c1, recv: c2 } : { send: c2, recv: c1 };
  }
}

export function createHandshake(o: HandshakeOptions): Handshake {
  return new HandshakeState(o);
}
