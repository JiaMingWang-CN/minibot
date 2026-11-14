// 检查更新与更新的命令对比（扩展第 4 期 Task 4）。

import { buildPreview, type InstallPreview, type InstallPreviewServer } from './install.ts';
import type { PluginBundle } from './manifest.ts';

export interface CommandChange {
  server: string;
  before: string | null;
  after: string | null;
}

export interface UpdatePreview extends InstallPreview {
  commandChanges: CommandChange[];
}

/** 把一个 server 的命令行/地址、cwd、env、headers 拼成可比较、可展示的多行文本 */
function describeServer(s: InstallPreviewServer): string {
  const lines = [s.type === 'stdio' ? (s.commandLine ?? '') : (s.url ?? '')];
  if (s.type === 'stdio') lines.push(`cwd: ${s.cwd}`);
  for (const [label, entries] of [['env', s.env], ['headers', s.headers]] as const) {
    if (entries !== undefined && entries.length > 0) {
      lines.push(`${label}: ${entries.map((e) => `${e.name}=${e.value}`).join(', ')}`);
    }
  }
  return lines.join('\n');
}

function serverDescriptions(bundle: PluginBundle, target: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of buildPreview('', bundle, target).servers) map.set(s.name, describeServer(s));
  return map;
}

/** 对比新旧每个 server 的命令行/地址、cwd、env、headers；新增、删除、改动都列出 */
export function diffStdioCommands(oldBundle: PluginBundle, newBundle: PluginBundle, target: string): CommandChange[] {
  const before = serverDescriptions(oldBundle, target);
  const after = serverDescriptions(newBundle, target);
  const names = new Set([...before.keys(), ...after.keys()]);
  const changes: CommandChange[] = [];
  for (const server of names) {
    const oldLine = before.get(server) ?? null;
    const newLine = after.get(server) ?? null;
    if (oldLine !== newLine) changes.push({ server, before: oldLine, after: newLine });
  }
  return changes;
}
