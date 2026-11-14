// 安装预览的构造与目录移动（扩展第 4 期 Task 3）。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { renameWithRetry, type AtomicDeps } from '../fs/atomic-write.ts';
import type { PluginBundle, PluginManifest } from './manifest.ts';

export interface InstallPreviewServer {
  name: string;
  type: 'stdio' | 'http';
  commandLine?: string;
  url?: string;
  cwd: string;
  /** stdio：环境变量名与值（${config.*} 原样显示，${PLUGIN_ROOT} 换成安装路径） */
  env?: InstallPreviewEntry[];
  /** http：请求头名与值，规则同 env */
  headers?: InstallPreviewEntry[];
}

export interface InstallPreviewEntry {
  name: string;
  value: string;
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

function previewEntries(values: Record<string, { value: string }>, target: string): InstallPreviewEntry[] {
  return Object.entries(values).map(([name, v]) => ({ name, value: replacePluginRoot(v.value, target) }));
}

export function buildPreview(token: string, bundle: PluginBundle, target: string): InstallPreview {
  const servers: InstallPreviewServer[] = bundle.mcp.map((draft) => {
    const t = draft.transport;
    if (t.type === 'stdio') {
      // 与运行时一致：未写 cwd 时在插件目录运行
      const cwd = t.cwd === null ? target : replacePluginRoot(t.cwd, target);
      return {
        name: draft.name,
        type: 'stdio',
        commandLine: commandLineFor(t.command, t.args, target),
        cwd,
        env: previewEntries(t.env, target),
      };
    }
    return { name: draft.name, type: 'http', url: replacePluginRoot(t.url, target), cwd: target, headers: previewEntries(t.headers, target) };
  });
  return {
    token,
    manifest: bundle.manifest,
    servers,
    skills: bundle.skillDirs.map((dir) => path.basename(dir)),
    problems: [...bundle.problems],
  };
}

/** 移动目录；跨设备时退化为复制 + 删除；文件被占用时重试 rename */
export async function moveDir(src: string, dest: string, deps?: AtomicDeps): Promise<void> {
  try {
    await renameWithRetry(src, dest, deps);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  await fs.cp(src, dest, { recursive: true, dereference: false });
  await fs.rm(src, { recursive: true, force: true });
}
