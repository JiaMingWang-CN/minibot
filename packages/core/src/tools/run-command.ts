import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  decodeOutput,
  detectAnsiEncoding,
  encodePowerShell,
  runProcess,
  trimUtf8End,
  trimUtf8Start,
  type RunProcessResult,
} from './process.ts';
import type { ToolOutput } from './types.ts';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
export const OUTPUT_LIMIT = 30_000;
export const OUTPUT_KEEP = 15_000;
export const OUTPUT_RETENTION_MS = 7 * 24 * 3600 * 1000;

async function pruneOutputs(dir: string): Promise<void> {
  const cutoff = Date.now() - OUTPUT_RETENTION_MS;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = await fs.stat(file);
      if (stat.isFile() && stat.mtimeMs < cutoff) await fs.unlink(file);
    } catch {
      // 清理失败不影响命令结果
    }
  }
}

let windowsShell: Promise<string> | undefined;

function detectWindowsShell(): Promise<string> {
  if (windowsShell === undefined) {
    windowsShell = new Promise<string>((resolve) => {
      execFile('where', ['pwsh'], { windowsHide: true }, (err) => {
        resolve(err ? 'powershell.exe' : 'pwsh');
      });
    });
  }
  return windowsShell;
}

async function shellCommand(command: string): Promise<{ file: string; args: string[] }> {
  if (process.platform !== 'win32') return { file: 'bash', args: ['-c', command] };
  return { file: await detectWindowsShell(), args: encodePowerShell(command) };
}

export async function runCommand(
  ctx: {
    cwd: string;
    outputsDir: string;
    signal: AbortSignal;
    /** 写入完整输出文件、返回给模型之前的脱敏 */
    redact?: (text: string) => string;
    env?: NodeJS.ProcessEnv;
  },
  a: { command: string; timeout_ms?: number },
): Promise<ToolOutput> {
  try {
    const stat = await fs.stat(ctx.cwd);
    if (!stat.isDirectory()) {
      return { content: `工作目录不存在：${ctx.cwd}`, isError: true };
    }
  } catch {
    return { content: `工作目录不存在：${ctx.cwd}`, isError: true };
  }

  const requested = a.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(1, Math.trunc(requested)), MAX_TIMEOUT_MS);
  const shell = await shellCommand(a.command);

  let result: RunProcessResult;
  try {
    result = await runProcess({
      file: shell.file,
      args: shell.args,
      cwd: ctx.cwd,
      timeoutMs,
      signal: ctx.signal,
      ...(ctx.env !== undefined ? { env: ctx.env } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `命令启动失败：${message}`, isError: true };
  }

  const encoding = await detectAnsiEncoding();
  const raw =
    result.droppedBytes === 0
      ? decodeOutput(result.output, encoding)
      : `${decodeOutput(trimUtf8End(result.output), encoding)}\n[已丢弃中间 ${result.droppedBytes} 字节输出]\n${decodeOutput(trimUtf8Start(result.tail), encoding)}`;
  const text = ctx.redact === undefined ? raw : ctx.redact(raw);
  let display = text;
  if (text.length > OUTPUT_LIMIT) {
    await fs.mkdir(ctx.outputsDir, { recursive: true });
    await pruneOutputs(ctx.outputsDir);
    const fileName = `output-${Date.now()}-${randomBytes(4).toString('hex')}.txt`;
    const fullPath = path.join(ctx.outputsDir, fileName);
    await fs.writeFile(fullPath, text, 'utf8');
    const omitted = text.length - OUTPUT_LIMIT;
    display = `${text.slice(0, OUTPUT_KEEP)}[已省略中间 ${omitted} 个字符，完整输出见 ${fullPath}]\n${text.slice(-OUTPUT_KEEP)}`;
  }

  const header = `退出码: ${result.exitCode === null ? 'null' : result.exitCode}\n超时: ${
    result.timedOut ? '是' : '否'
  }\n耗时: ${(result.durationMs / 1000).toFixed(2)}s\n输出:\n`;
  return { content: header + display, isError: false };
}
