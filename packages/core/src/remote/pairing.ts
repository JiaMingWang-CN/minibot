import { randomBytes } from 'node:crypto';

export const PAIR_CODE_PREFIX = 'minibot-pair:';
export const PAIRING_TTL_MS = 300_000;

export interface PairingOffer {
  /** 二维码文本 */
  code: string;
  expiresAt: number;
}

export interface PairingPayload {
  v: 1;
  relay: string | null;
  token: string | null;
  /** 电脑公钥，base64url */
  pk: string;
  /** 本次配对的一次性 psk，base64url */
  psk: string;
  name: string;
  lan: string[];
  port: number;
}

export interface ActiveOffer extends PairingOffer {
  psk: Buffer;
}

export function createOffer(
  now: number,
  info: { relay: string | null; token: string | null; publicKey: Buffer; name: string; lan: string[]; port: number },
): ActiveOffer {
  const psk = randomBytes(32);
  const payload: PairingPayload = {
    v: 1,
    relay: info.relay,
    token: info.token,
    pk: info.publicKey.toString('base64url'),
    psk: psk.toString('base64url'),
    name: info.name,
    lan: info.lan,
    port: info.port,
  };
  const code = PAIR_CODE_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { code, expiresAt: now + PAIRING_TTL_MS, psk };
}

/** 解析配对码（手机侧 / 测试手机使用） */
export function parsePairingCode(code: string): PairingPayload {
  if (!code.startsWith(PAIR_CODE_PREFIX)) throw new Error('不是 minibot 配对码');
  const payload = JSON.parse(Buffer.from(code.slice(PAIR_CODE_PREFIX.length), 'base64url').toString('utf8')) as PairingPayload;
  if (payload.v !== 1) throw new Error('配对码版本不支持');
  return payload;
}
