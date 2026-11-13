import net from 'node:net';

/**
 * 地址守卫：判断一个 IP 能不能连。
 * 覆盖回环、私有网段、链路本地、组播、未指定、运营商级 NAT、保留地址，
 * 以及这些地址的 IPv4 映射 IPv6 形式。解析不了的一律按拒绝处理（fail closed）。
 */

function parseIPv4(input: string): number | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value * 256 + n) >>> 0;
  }
  return value >>> 0;
}

function inCidr4(ip: number, base: string, prefix: number): boolean {
  const baseValue = parseIPv4(base);
  if (baseValue === null) return false;
  if (prefix <= 0) return true;
  const mask = prefix >= 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1) >>> 0);
  return ((ip & mask) >>> 0) === ((baseValue & mask) >>> 0);
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function blockedIPv4(ip: number): boolean {
  return V4_BLOCKED.some(([base, prefix]) => inCidr4(ip, base, prefix));
}

/** 解析 IPv6 为 128 位整数；支持 :: 压缩、末尾内嵌 IPv4 */
function parseIPv6(input: string): bigint | null {
  let s = input.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.length === 0 || s.includes('%')) return null;

  const lastColon = s.lastIndexOf(':');
  if (lastColon >= 0) {
    const maybeV4 = s.slice(lastColon + 1);
    if (maybeV4.includes('.')) {
      const v4 = parseIPv4(maybeV4);
      if (v4 === null) return null;
      s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
    }
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = toGroups(halves[0] ?? '');
  if (head === null) return null;
  const tail = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  if (tail === null) return null;

  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value;
}

function blockedIPv6(value: bigint): boolean {
  if (value === 0n) return true; // ::
  if (value === 1n) return true; // ::1
  const top16 = Number(value >> 112n);
  // fc00::/7 唯一本地地址
  if ((top16 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 链路本地
  if ((top16 & 0xffc0) === 0xfe80) return true;
  // ff00::/8 组播
  if ((top16 & 0xff00) === 0xff00) return true;
  // 2001:db8::/32 文档地址
  if (value >> 96n === 0x20010db8n) return true;
  // 100::/64 仅丢弃
  if (value >> 64n === 0x100n) return true;
  // IPv4 映射（::ffff:0:0/96）与 IPv4 兼容（::/96）按 IPv4 规则判断
  const high96 = value >> 32n;
  if (high96 === 0xffffn || high96 === 0n) return blockedIPv4(Number(value & 0xffffffffn));
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const trimmed = ip.trim();
  const v4 = parseIPv4(trimmed);
  if (v4 !== null) return blockedIPv4(v4);
  if (net.isIPv6(trimmed)) {
    const v6 = parseIPv6(trimmed);
    return v6 === null ? true : blockedIPv6(v6);
  }
  return true;
}
