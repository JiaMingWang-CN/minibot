import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface AtomicDeps {
  rename: typeof fs.rename;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_DELAYS = [20, 40, 60, 80, 100];
const RETRY_BUDGET_MS = 2000;

const defaultDeps: AtomicDeps = {
  rename: fs.rename,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export async function atomicWriteFile(
  target: string,
  data: string | Buffer,
  deps: AtomicDeps = defaultDeps,
  /** 目标不存在时新文件的权限位（POSIX）；默认按 umask。密钥类文件传 0o600 */
  newFileMode?: number,
): Promise<void> {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${path.basename(target)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  // 改名会换掉文件本身：目标已存在时沿用它的权限位（可执行位等），否则新文件会丢掉
  const mode = await fs.stat(target).then(
    (s) => s.mode & 0o7777,
    () => undefined,
  );
  try {
    const fh = await fs.open(tmp, 'w', newFileMode ?? 0o666);
    try {
      await fh.writeFile(data);
      if (process.platform !== 'win32') {
        const want = mode ?? newFileMode;
        if (want !== undefined) await fh.chmod(want);
      }
      await fh.sync();
    } finally {
      await fh.close();
    }
    await renameWithRetry(tmp, target, deps);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** rename，遇 Windows 上常见的文件占用错误（EPERM/EACCES/EBUSY）短暂重试 */
export async function renameWithRetry(tmp: string, target: string, deps: AtomicDeps = defaultDeps): Promise<void> {
  const started = deps.now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await deps.rename(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !RETRY_CODES.has(code)) throw err;
      if (deps.now() - started >= RETRY_BUDGET_MS) throw err;
      await deps.sleep(RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)] ?? 100);
    }
  }
}
