import { glob } from 'node:fs/promises';
import path from 'node:path';
import { rgPath as rgBinary } from '@vscode/ripgrep';
import { decodeOutput, runProcess } from './process.ts';
import type { ToolOutput } from './types.ts';

export const GLOB_MAX = 500;
export const GREP_MAX = 200;

const GLOB_EXCLUDE = [
  '.git',
  'node_modules',
  '**/.git',
  '**/node_modules',
  '**/.git/**',
  '**/node_modules/**',
];

export function rgPath(): string {
  return rgBinary.replace('app.asar', 'app.asar.unpacked');
}

export async function globFiles(
  dir: string,
  a: { pattern: string },
  signal?: AbortSignal,
): Promise<ToolOutput> {
  const results: string[] = [];
  const root = path.resolve(dir);
  for await (const entry of glob(a.pattern, { cwd: dir, exclude: GLOB_EXCLUDE })) {
    if (signal?.aborted === true) return { content: '已取消', isError: true };
    // 审批只按搜索根目录分类；模式里的 ../ 或绝对路径不能借此越出根目录
    const rel = path.relative(root, path.resolve(root, entry));
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    results.push(entry.split(path.sep).join('/'));
  }
  results.sort();
  if (results.length === 0) return { content: '没有匹配的文件', isError: false };
  const shown = results.slice(0, GLOB_MAX);
  let content = shown.join('\n');
  if (results.length > GLOB_MAX) {
    content += `\n[结果超过 ${GLOB_MAX} 个，仅显示前 ${GLOB_MAX} 个]`;
  }
  return { content, isError: false };
}

export async function grepFiles(
  dir: string,
  a: { pattern: string; glob?: string; ignore_case?: boolean },
  signal: AbortSignal,
): Promise<ToolOutput> {
  const args = [
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--max-columns',
    '500',
    '--no-require-git',
  ];
  if (a.ignore_case === true) args.push('-i');
  if (a.glob !== undefined && a.glob.length > 0) args.push('--glob', a.glob);
  args.push('-e', a.pattern, '.');

  const result = await runProcess({
    file: rgPath(),
    args,
    cwd: dir,
    timeoutMs: 60_000,
    signal,
  });
  const text = decodeOutput(result.output, 'utf-8');

  if (result.exitCode === 1) return { content: '无匹配', isError: false };
  if (result.exitCode !== 0) {
    return { content: `搜索失败：${text.trim() || '未知错误'}`, isError: true };
  }

  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\.\\/, '').replace(/^\.\//, ''));
  if (lines.length === 0) return { content: '无匹配', isError: false };
  const shown = lines.slice(0, GREP_MAX);
  let content = shown.join('\n');
  if (lines.length > GREP_MAX) {
    content += `\n[匹配超过 ${GREP_MAX} 条，仅显示前 ${GREP_MAX} 条]`;
  }
  return { content, isError: false };
}
