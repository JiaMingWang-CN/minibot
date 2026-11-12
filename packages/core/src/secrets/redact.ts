export const REDACTED = '[REDACTED_API_KEY]';

export class SecretSet {
  private keys = new Set<string>();

  add(v: string): void {
    if (v.length >= 8) this.keys.add(v);
  }

  remove(v: string): void {
    this.keys.delete(v);
  }

  redact(text: string): string {
    if (this.keys.size === 0) return text;
    let out = text;
    const sorted = [...this.keys].sort((a, b) => b.length - a.length);
    for (const key of sorted) out = out.split(key).join(REDACTED);
    return out;
  }

  /** 流式脱敏器：每个流（一次模型调用）新建一个 */
  streamRedactor(): StreamRedactor {
    return new StreamRedactor(this);
  }

  /** text 末尾最长的、可能是某个 Key 开头（但还不是完整 Key）的一段的长度 */
  pendingPrefixLength(text: string): number {
    let longest = 0;
    for (const key of this.keys) {
      const max = Math.min(key.length - 1, text.length);
      for (let n = max; n > longest; n -= 1) {
        if (text.endsWith(key.slice(0, n))) {
          longest = n;
          break;
        }
      }
    }
    return longest;
  }

  containsKnown(text: string): boolean {
    for (const key of this.keys) {
      if (text.includes(key)) return true;
    }
    return false;
  }
}

/**
 * 流式增量的脱敏：Key 可能被切在两个增量之间，单独脱敏每个增量会漏。
 * text / reasoning 分别缓冲，每次只放出“不可能是某个 Key 开头”的部分，
 * 末尾可能是 Key 开头的一小段留到下个增量；流结束时 flush 放出剩余。
 * 没有登记任何 Key 时直接透传。
 */
export class StreamRedactor {
  private secrets: SecretSet;
  private pending: Record<'text' | 'reasoning', string> = { text: '', reasoning: '' };

  constructor(secrets: SecretSet) {
    this.secrets = secrets;
  }

  push(type: 'text' | 'reasoning', chunk: string): string {
    // 先对整段（上次留下的 + 这次的）脱敏，再把末尾可能是 Key 开头的一段留下
    const redacted = this.secrets.redact(this.pending[type] + chunk);
    const hold = this.secrets.pendingPrefixLength(redacted);
    this.pending[type] = redacted.slice(redacted.length - hold);
    return redacted.slice(0, redacted.length - hold);
  }

  flush(type: 'text' | 'reasoning'): string {
    const rest = this.secrets.redact(this.pending[type]);
    this.pending[type] = '';
    return rest;
  }
}
