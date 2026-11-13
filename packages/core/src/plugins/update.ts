// 检查更新与更新的命令对比（扩展第 4 期 Task 4）。

import { commandLineFor, type InstallPreview } from './install.ts';
import type { PluginBundle } from './manifest.ts';

export interface CommandChange {
  server: string;
  before: string | null;
  after: string | null;
}

export interface UpdatePreview extends InstallPreview {
  commandChanges: CommandChange[];
}

function stdioCommandLines(bundle: PluginBundle, target: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const draft of bundle.mcp) {
    const t = draft.transport;
    if (t.type === 'stdio') map.set(draft.name, commandLineFor(t.command, t.args, target));
  }
  return map;
}

/** 对比新旧每个 stdio server 的命令行；新增、删除、改动都列出 */
export function diffStdioCommands(oldBundle: PluginBundle, newBundle: PluginBundle, target: string): CommandChange[] {
  const before = stdioCommandLines(oldBundle, target);
  const after = stdioCommandLines(newBundle, target);
  const names = new Set([...before.keys(), ...after.keys()]);
  const changes: CommandChange[] = [];
  for (const server of names) {
    const oldLine = before.get(server) ?? null;
    const newLine = after.get(server) ?? null;
    if (oldLine !== newLine) changes.push({ server, before: oldLine, after: newLine });
  }
  return changes;
}
