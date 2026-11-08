export class ReadTracker {
  private hashes = new Map<string, string>();

  private key(real: string): string {
    return process.platform === 'win32' ? real.toLowerCase() : real;
  }

  record(real: string, hash: string): void {
    this.hashes.set(this.key(real), hash);
  }

  get(real: string): string | undefined {
    return this.hashes.get(this.key(real));
  }
}
