// 安装预览的构造与目录移动（扩展第 4 期 Task 3）。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PluginBundle, PluginManifest } from './manifest.ts';

export interface InstallPreviewServer {
  name: string;
  type: 'stdio' | 'http';
  commandLine?: string;
  url?: string;
  cwd: string;
}

export interface InstallPreview {
  token: string;
  manifest: PluginManifest;
  servers: InstallPreviewServer[];
  skills: string[];
  problems: string[];
}

function replacePluginRoot(text: string, target: string): string {
  return text.split('${PLUGIN_ROOT}').join(target);
}

function quoteArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/** 预览里的命令行：${PLUGIN_ROOT} 显示为最终安装路径，${config.*} 原样显示 */
export function commandLineFor(command: string, args: string[], target: string): string {
  return [command, ...args].map((part) => quoteArg(replacePluginRoot(part, target))).join(' ');
}

export function buildPreview(token: string, bundle: PluginBundle, target: string): InstallPreview {
  const servers: InstallPreviewServer[] = bundle.mcp.map((draft) => {
    const t = draft.transport;
    if (t.type === 'stdio') {
      // 与运行时一致：未写 cwd 时在插件目录运行
      const cwd = t.cwd === null ? target : replacePluginRoot(t.cwd, target);
      return { name: draft.name, type: 'stdio', commandLine: commandLineFor(t.command, t.args, target), cwd };
    }
    return { name: draft.name, type: 'http', url: replacePluginRoot(t.url, target), cwd: target };
  });
  return {
    token,
    manifest: bundle.manifest,
    servers,
    skills: bundle.skillDirs.map((dir) => path.basename(dir)),
    problems: [...bundle.problems],
  };
}

/** 移动目录；跨设备时退化为复制 + 删除 */
export async function moveDir(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  await fs.cp(src, dest, { recursive: true, dereference: false });
  await fs.rm(src, { recursive: true, force: true });
}
