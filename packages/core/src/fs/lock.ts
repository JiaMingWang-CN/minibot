import { createHash } from 'node:crypto';

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

const locks = new Map<string, Promise<void>>();

export async function withPathLock<T>(realPath: string, fn: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
  const previous = locks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => gate);
  locks.set(key, chain);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    void chain.then(() => {
      if (locks.get(key) === chain) locks.delete(key);
    });
  }
}
