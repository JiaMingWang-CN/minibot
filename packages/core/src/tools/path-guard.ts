import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import type { DataPaths } from '../paths.ts';

export async function resolveReal(input: string, base: string, home: string = os.homedir()): Promise<string> {
  let expanded = input;
  if (input === '~') expanded = home;
  else if (input.startsWith('~/') || input.startsWith('~\\')) {
    expanded = path.join(home, input.slice(1).replace(/^[\\/]+/, ''));
  }
  const absolute = path.isAbsolute(expanded) ? expanded : path.join(base, expanded);
  const normalized = path.resolve(absolute);

  try {
    return await fs.realpath(normalized);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const missing: string[] = [path.basename(normalized)];
  let current = path.dirname(normalized);
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return path.join(real, ...missing.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const parent = path.dirname(current);
    if (parent === current) return normalized;
    missing.push(path.basename(current));
    current = parent;
  }
}

function stripTrailingSeparators(p: string, sep: string): string {
  let out = p;
  while (out.length > 1 && out.endsWith(sep)) out = out.slice(0, -1);
  return out;
}

export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const sep = platform === 'win32' ? '\\' : '/';
  let c = platform === 'win32' ? child.replace(/\//g, '\\') : child;
  let p = platform === 'win32' ? parent.replace(/\//g, '\\') : parent;
  if (platform === 'win32') {
    c = c.toLowerCase();
    p = p.toLowerCase();
  }
  c = stripTrailingSeparators(c, sep);
  p = stripTrailingSeparators(p, sep);
  if (c === p) return true;
  if (p === sep) return c.startsWith(sep);
  if (!c.startsWith(p)) return false;
  return c[p.length] === sep;
}

export type PathClass = 'sensitive' | 'own_memory' | 'workspace' | 'outside';

export interface ClassifyContext {
  paths: DataPaths;
  botId: string;
  workspace: string;
  home: string;
  platform?: NodeJS.Platform;
}

export function classifyPath(real: string, ctx: ClassifyContext): PathClass {
  const platform = ctx.platform ?? process.platform;
  if (isInside(real, ctx.paths.secrets, platform) || isInside(real, ctx.paths.config, platform)) {
    return 'sensitive';
  }
  if (isInside(real, path.join(ctx.home, '.ssh'), platform)) return 'sensitive';
  if (isInside(real, ctx.paths.userMd, platform)) return 'own_memory';
  if (isInside(real, ctx.paths.memoryDir(ctx.botId), platform)) return 'own_memory';
  // 本 bot 没设工作目录时用的默认工作区在数据目录里面，照常算工作区
  if (isInside(real, ctx.paths.defaultWorkspace(ctx.botId), platform)) return 'workspace';
  // 数据目录里其余一切（bot.json、devices.json、remote.json、数据库等）都敏感；
  // 必须先于“是否在工作区内”判断，否则工作区设成主目录时会把它们当普通文件
  if (isInside(real, ctx.paths.root, platform)) return 'sensitive';
  if (isInside(real, ctx.workspace, platform)) return 'workspace';
  return 'outside';
}
