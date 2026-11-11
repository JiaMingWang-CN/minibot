import { spawn, spawnSync, execFile, type ChildProcess } from 'node:child_process';

export interface RunProcessOptions {
  file: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** 内存中保留的输出开头部分的字节上限，默认 8 MiB */
  maxOutputBytes?: number;
  /** 超出上限后保留的结尾部分字节数，默认 1 MiB */
  tailBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TAIL_BYTES = 1024 * 1024;

export interface RunProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  /** 输出开头部分（未超限时为全部输出） */
  output: Buffer;
  /** 超限时的输出结尾部分；未超限时为空 */
  tail: Buffer;
  /** 中间丢弃的字节数；未超限时为 0 */
  droppedBytes: number;
}

export function killTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // 进程可能已经退出
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // 已退出
    }
  }, 2000).unref();
}

export function runProcess(p: RunProcessOptions): Promise<RunProcessResult> {
  const started = Date.now();
  if (p.signal.aborted) {
    return Promise.resolve({
      exitCode: null,
      timedOut: false,
      aborted: true,
      durationMs: 0,
      output: Buffer.alloc(0),
      tail: Buffer.alloc(0),
      droppedBytes: 0,
    });
  }

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(p.file, p.args, {
        cwd: p.cwd,
        env: p.env ?? process.env,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    const headLimit = p.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const tailLimit = p.tailBytes ?? DEFAULT_TAIL_BYTES;
    const head: Buffer[] = [];
    let headSize = 0;
    const tail: Buffer[] = [];
    let tailSize = 0;
    let dropped = 0;
    const collect = (chunk: Buffer): void => {
      let rest = chunk;
      if (headSize < headLimit) {
        const take = Math.min(headLimit - headSize, rest.length);
        head.push(rest.subarray(0, take));
        headSize += take;
        rest = rest.subarray(take);
      }
      if (rest.length === 0) return;
      tail.push(rest);
      tailSize += rest.length;
      while (tailSize > tailLimit && tail.length > 0) {
        const first = tail[0]!;
        const excess = tailSize - tailLimit;
        if (first.length <= excess) {
          tail.shift();
          tailSize -= first.length;
          dropped += first.length;
        } else {
          tail[0] = first.subarray(excess);
          tailSize -= excess;
          dropped += excess;
        }
      }
    };
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let timedOut = false;
    let aborted = false;
    // finish 在计时器创建之前就要能引用它，所以先声明后赋值
    // eslint-disable-next-line prefer-const
    let timeoutTimer: NodeJS.Timeout | undefined;

    const onAbort = (): void => {
      if (exited) return;
      aborted = true;
      if (child.pid !== undefined) killTree(child.pid);
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      p.signal.removeEventListener('abort', onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        exitCode,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        output: dropped === 0 ? Buffer.concat([...head, ...tail]) : Buffer.concat(head),
        tail: dropped === 0 ? Buffer.alloc(0) : Buffer.concat(tail),
        droppedBytes: dropped,
      });
    };

    timeoutTimer = setTimeout(() => {
      if (exited) return;
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
    }, p.timeoutMs);
    p.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      p.signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      setTimeout(finish, 500).unref();
    });
    child.on('close', () => finish());
  });
}

const CODE_PAGE_LABELS: Record<string, string> = {
  '936': 'gbk',
  '950': 'big5',
  '932': 'shift_jis',
  '949': 'euc-kr',
};

let ansiCache: Promise<string> | undefined;

export function detectAnsiEncoding(): Promise<string> {
  if (ansiCache === undefined) ansiCache = detectAnsiEncodingImpl();
  return ansiCache;
}

async function detectAnsiEncodingImpl(): Promise<string> {
  if (process.platform !== 'win32') return 'utf-8';
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'reg',
        ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'],
        { windowsHide: true },
        (err, out) => (err ? reject(err) : resolve(out)),
      );
    });
    const match = /REG_SZ\s+(\d+)/.exec(stdout);
    if (match === null) return 'windows-1252';
    return CODE_PAGE_LABELS[match[1] ?? ''] ?? 'windows-1252';
  } catch {
    return 'windows-1252';
  }
}

export function decodeOutput(buf: Buffer, fallback: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder(fallback).decode(buf);
    } catch {
      return new TextDecoder('utf-8').decode(buf);
    }
  }
}

// 去掉开头被截断的 UTF-8 续字节，或结尾不完整的多字节序列，避免拼接处解码失败。
export function trimUtf8Start(buf: Buffer): Buffer {
  let i = 0;
  while (i < Math.min(3, buf.length) && (buf[i]! & 0xc0) === 0x80) i += 1;
  return buf.subarray(i);
}

export function trimUtf8End(buf: Buffer): Buffer {
  for (let back = 1; back <= Math.min(4, buf.length); back += 1) {
    const byte = buf[buf.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? buf.subarray(0, buf.length - back) : buf;
  }
  return buf;
}

export function encodePowerShell(command: string): string[] {
  const prefix =
    '$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ';
  const encoded = Buffer.from(prefix + command, 'utf16le').toString('base64');
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
}
