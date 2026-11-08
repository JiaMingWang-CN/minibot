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

  containsKnown(text: string): boolean {
    for (const key of this.keys) {
      if (text.includes(key)) return true;
    }
    return false;
  }
}
