// 插件市场：读取 marketplace.json，准备市场仓库缓存（扩展第 4 期 Task 3）。

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runProcess } from '../tools/process.ts';
import { GIT_TIMEOUT_MS, assertGitUrl, type StageOptions } from './sources.ts';

export interface MarketEntry {
  name: string;
  description: string;
  version: string;
  source: { git: string; ref?: string; path?: string };
}

export interface MarketReadResult {
  entries: MarketEntry[];
  problems: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseEntry(raw: unknown): MarketEntry | null {
  if (!isRecord(raw)) return null;
  const name = typeof raw['name'] === 'string' ? raw['name'] : '';
  const description = typeof raw['description'] === 'string' ? raw['description'] : '';
  const version = typeof raw['version'] === 'string' ? raw['version'] : '';
  const sourceRaw = raw['source'];
  if (name.length === 0 || !isRecord(sourceRaw) || typeof sourceRaw['git'] !== 'string') return null;
  const source: MarketEntry['source'] = { git: sourceRaw['git'] };
  if (typeof sourceRaw['ref'] === 'string') source.ref = sourceRaw['ref'];
  if (typeof sourceRaw['path'] === 'string') {
    // path 必须是仓库内的相对路径：不能是绝对路径，不能含 ..
    const p = sourceRaw['path'].replace(/\\/g, '/');
    if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.split('/').includes('..')) return null;
    source.path = sourceRaw['path'];
  }
  return { name, description, version, source };
}

/** 读取 marketDir 根目录的 marketplace.json；不合规条目跳过并计入 problems */
export async function readMarketEntries(marketDir: string): Promise<MarketReadResult> {
  const problems: string[] = [];
  let text: string;
  try {
    text = await fs.readFile(path.join(marketDir, 'marketplace.json'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('市场缺少 marketplace.json');
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`marketplace.json 不是有效的 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(raw) || !Array.isArray(raw['plugins'])) {
    throw new Error('marketplace.json 结构不合规：缺少 plugins 数组');
  }
  const entries: MarketEntry[] = [];
  const seen = new Set<string>();
  raw['plugins'].forEach((item, index) => {
    const entry = parseEntry(item);
    if (entry === null) {
      const label = isRecord(item) && typeof item['name'] === 'string' ? item['name'] : String(index);
      problems.push(`市场条目不合规：${label}`);
      return;
    }
    if (seen.has(entry.name)) {
      problems.push(`市场条目重名：${entry.name}`);
      return;
    }
    seen.add(entry.name);
    entries.push(entry);
  });
  return { entries, problems };
}

export function cacheDirFor(cacheRoot: string, url: string): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
  return path.join(cacheRoot, hash);
}

async function git(args: string[], cwd: string, opts: StageOptions): Promise<void> {
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
  if (result.exitCode !== 0) {
    const text = (result.output.toString('utf8') + result.tail.toString('utf8')).trim();
    throw new Error(`Git 操作失败：${text.split(/\r?\n/).slice(-3).join('\n')}`);
  }
}

/** 浅克隆市场仓库到缓存目录；已有则 fetch 后重置 */
export async function ensureMarketRepo(marketUrl: string, cacheRoot: string, opts: StageOptions = {}): Promise<string> {
  assertGitUrl(marketUrl, opts.gitUrlOk);
  const dir = cacheDirFor(cacheRoot, marketUrl);
  const exists = await fs.stat(path.join(dir, '.git')).then(() => true, () => false);
  await fs.mkdir(cacheRoot, { recursive: true });
  if (!exists) {
    await fs.rm(dir, { recursive: true, force: true });
    await git(['clone', '--depth', '1', marketUrl, dir], cacheRoot, opts);
    return dir;
  }
  await git(['fetch', '--depth', '1', 'origin'], dir, opts);
  await git(['reset', '--hard', 'FETCH_HEAD'], dir, opts);
  return dir;
}
