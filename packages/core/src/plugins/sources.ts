// 插件安装来源：把文件夹 / zip / Git 取到临时目录（扩展第 4 期 Task 3）。

import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { open as openZip, type Entry, type ZipFile } from 'yauzl';
import { runProcess } from '../tools/process.ts';
import { isInside } from '../tools/path-guard.ts';
import type { PluginSource } from './registry.ts';

export type InstallSource =
  | { kind: 'folder'; path: string }
  | { kind: 'zip'; path: string }
  | { kind: 'git'; url: string; ref?: string }
  | { kind: 'market'; marketUrl: string; name: string };

export interface StageOptions {
  signal?: AbortSignal;
  /** 允许的 Git 地址判定；默认只允许 https://。测试可注入以跑通本地仓库 */
  gitUrlOk?: (url: string) => boolean;
  maxZipEntries?: number;
  maxZipBytes?: number;
}

export const MAX_ZIP_ENTRIES = 5000;
export const MAX_ZIP_BYTES = 100 * 1024 * 1024;
export const GIT_TIMEOUT_MS = 120_000;

export function isHttpsGit(url: string): boolean {
  return typeof url === 'string' && url.startsWith('https://');
}

export function assertGitUrl(url: string, ok: (url: string) => boolean = isHttpsGit): void {
  if (!ok(url)) throw new Error('只支持 https:// 开头的 Git 地址');
}

async function runGit(args: string[], cwd: string, opts: StageOptions): Promise<string> {
  let result;
  try {
    result = await runProcess({
      file: 'git',
      args,
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
      signal: opts.signal ?? new AbortController().signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('需要先安装 Git');
    throw err;
  }
  const text = result.output.toString('utf8') + result.tail.toString('utf8');
  if (result.exitCode !== 0) {
    const reason = text.trim().split(/\r?\n/).slice(-3).join('\n');
    throw new Error(`Git 操作失败：${reason.length > 0 ? reason : `退出码 ${String(result.exitCode)}`}`);
  }
  return text;
}

/** 深拷贝目录（不跟随符号链接） */
export async function stageFolder(srcPath: string, dest: string): Promise<void> {
  await fs.cp(srcPath, dest, { recursive: true, dereference: false });
}

function zipEntrySafe(name: string, dest: string): boolean {
  if (name.length === 0 || name.includes('\0')) return false;
  const forward = name.replace(/\\/g, '/');
  if (forward.startsWith('/') || /^[a-zA-Z]:/.test(forward)) return false;
  const parts = forward.split('/');
  if (parts.some((part) => part === '..')) return false;
  const target = path.resolve(dest, forward);
  return isInside(target, dest);
}

/** yauzl 自身的文件名安全检查错误（absolute path / invalid relative path / backslash / invalid characters）→ 统一文案 */
function translateZipError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const match = /^(?:absolute path|invalid relative path|backslash|invalid characters in fileName):\s*(.*)$/i.exec(err.message);
  if (match !== null) return new Error(`zip 包含不安全的路径：${match[1]}`);
  return err;
}

/** 解压 zip 到 dest；拒绝路径逃逸、符号链接，限制条目数与解压后总大小 */
export async function stageZip(zipPath: string, dest: string, opts: StageOptions = {}): Promise<void> {
  const maxEntries = opts.maxZipEntries ?? MAX_ZIP_ENTRIES;
  const maxBytes = opts.maxZipBytes ?? MAX_ZIP_BYTES;
  await fs.mkdir(dest, { recursive: true });

  const zipfile = await new Promise<ZipFile>((resolve, reject) => {
    openZip(zipPath, { lazyEntries: true, autoClose: true, decodeStrings: true, strictFileNames: false }, (err, zf) => {
      if (err !== null) reject(err);
      else resolve(zf);
    });
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let count = 0;
    let total = 0;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      try {
        zipfile.close();
      } catch {
        // 已关闭
      }
      reject(err);
    };
    zipfile.on('error', (err: Error) => fail(translateZipError(err) as Error));
    zipfile.on('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zipfile.on('entry', (entry: Entry) => {
      void (async (): Promise<void> => {
        count += 1;
        if (count > maxEntries) throw new Error('zip 条目超过 5000 个');
        const name = entry.fileName;
        if (!zipEntrySafe(name, dest)) throw new Error(`zip 包含不安全的路径：${name}`);
        // 符号链接：unix 模式高 16 位里的文件类型位为 0xA000
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((mode & 0xf000) === 0xa000) throw new Error(`zip 包含不安全的路径：${name}`);
        total += entry.uncompressedSize;
        if (total > maxBytes) throw new Error('zip 解压后超过 100 MB');
        const forward = name.replace(/\\/g, '/');
        const target = path.resolve(dest, forward);
        if (forward.endsWith('/')) {
          await fs.mkdir(target, { recursive: true });
          return;
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => {
          zipfile.openReadStream(entry, (err, rs) => (err !== null ? rej(err) : res(rs)));
        });
        await new Promise<void>((res, rej) => {
          const ws = createWriteStream(target);
          stream.on('error', rej);
          ws.on('error', rej);
          ws.on('close', () => res());
          (stream as NodeJS.ReadableStream & { pipe(d: NodeJS.WritableStream): void }).pipe(ws);
        });
      })().then(
        () => {
          if (!settled) zipfile.readEntry();
        },
        (err: unknown) => fail(err instanceof Error ? err : new Error(String(err))),
      );
    });
    zipfile.readEntry();
  });
}

/** 浅克隆 Git 仓库到 dest，返回 HEAD commit */
export async function stageGit(url: string, ref: string | undefined, dest: string, opts: StageOptions = {}): Promise<string> {
  assertGitUrl(url, opts.gitUrlOk);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const args = ['clone', '--depth', '1'];
  if (ref !== undefined && ref.length > 0) args.push('--branch', ref);
  args.push(url, dest);
  await runGit(args, path.dirname(dest), opts);
  const head = await runGit(['rev-parse', 'HEAD'], dest, opts);
  return head.trim();
}

/** git ls-remote 查远端 commit；失败返回 null */
export async function lsRemote(url: string, ref: string | null | undefined, cwd: string, opts: StageOptions = {}): Promise<string | null> {
  assertGitUrl(url, opts.gitUrlOk);
  const target = ref !== null && ref !== undefined && ref.length > 0 ? ref : 'HEAD';
  let text: string;
  try {
    text = await runGit(['ls-remote', url, target], cwd, opts);
  } catch {
    return null;
  }
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (line === undefined) return null;
  const hash = line.split('\t')[0]!.trim();
  return hash.length > 0 ? hash : null;
}

export interface StagedGit {
  dir: string;
  source: Extract<PluginSource, { kind: 'git' }>;
}
