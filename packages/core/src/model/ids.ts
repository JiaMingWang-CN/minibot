import { randomBytes } from 'node:crypto';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function newToolUseId(): string {
  const bytes = randomBytes(24);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += CHARS[bytes[i]! % CHARS.length];
  }
  return `tu_${out}`;
}
