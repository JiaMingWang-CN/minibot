import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import {
  decodeOutput,
  detectAnsiEncoding,
  encodePowerShell,
  runProcess,
  trimUtf8End,
  trimUtf8Start,
  type RunProcessResult,
} from './process.ts';
import { clipToOutputs, OUTPUT_KEEP, OUTPUT_LIMIT, OUTPUT_RETENTION_MS } from './output.ts';
import type { ToolOutput } from './types.ts';

export { OUTPUT_KEEP, OUTPUT_LIMIT, OUTPUT_RETENTION_MS };

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;

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
  const display = await clipToOutputs(text, ctx.outputsDir);

  const header = `退出码: ${result.exitCode === null ? 'null' : result.exitCode}\n超时: ${
    result.timedOut ? '是' : '否'
  }\n耗时: ${(result.durationMs / 1000).toFixed(2)}s\n输出:\n`;
  return { content: header + display, isError: false };
}
