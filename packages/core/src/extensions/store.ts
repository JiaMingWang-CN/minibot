import { promises as fs } from 'node:fs';
import { atomicWriteFile } from '../fs/atomic-write.ts';
import type { DataPaths } from '../paths.ts';
import type { McpServerConfig } from '../mcp/config.ts';
import type { InstalledPlugin } from '../plugins/registry.ts';

export type SearchEngine = 'none' | 'deepseek' | 'tavily';

export interface WebSettings {
  fetchEnabled: boolean;
  searchEngine: SearchEngine;
}

/** 扩展的全局设置；后续各期往里加字段，读写时保留不认识的字段 */
export interface ExtensionsFile {
  schemaVersion: 1;
  web: WebSettings;
  mcpServers: McpServerConfig[];
  plugins: InstalledPlugin[];
  markets: string[];
  [key: string]: unknown;
}

const ENGINES: readonly SearchEngine[] = ['none', 'deepseek', 'tavily'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function defaultExtensions(): ExtensionsFile {
  return {
    schemaVersion: 1,
    web: { fetchEnabled: true, searchEngine: 'none' },
    mcpServers: [],
    plugins: [],
    markets: [],
  };
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** 宽松读取已装插件：只保留带字符串 name 的条目，字段不完整时补默认值 */
function pluginList(raw: unknown): InstalledPlugin[] {
  if (!Array.isArray(raw)) return [];
  const out: InstalledPlugin[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec['name'] === 'string' ? rec['name'] : '';
    if (name.length === 0) continue;
    out.push({
      name,
      version: typeof rec['version'] === 'string' ? rec['version'] : '',
      builtin: rec['builtin'] === true,
      source:
        typeof rec['source'] === 'object' && rec['source'] !== null
          ? (rec['source'] as InstalledPlugin['source'])
          : { kind: 'local' },
      enabled: rec['enabled'] !== false,
      serverIds: stringList(rec['serverIds']),
      ...(typeof rec['config'] === 'object' && rec['config'] !== null
        ? { config: rec['config'] as Record<string, string> }
        : {}),
    });
  }
  return out;
}

function migrate(raw: unknown): ExtensionsFile {
  if (!isRecord(raw)) return defaultExtensions();
  const webRaw = raw['web'];
  const web: WebSettings = {
    fetchEnabled: isRecord(webRaw) ? webRaw['fetchEnabled'] !== false : true,
    searchEngine:
      isRecord(webRaw) && typeof webRaw['searchEngine'] === 'string' && (ENGINES as readonly string[]).includes(webRaw['searchEngine'])
        ? (webRaw['searchEngine'] as SearchEngine)
        : 'none',
  };
  // 保留未知字段，供后续版本读写不丢
  const mcpServers = Array.isArray(raw['mcpServers']) ? (raw['mcpServers'] as McpServerConfig[]) : [];
  const plugins = pluginList(raw['plugins']);
  const markets = stringList(raw['markets']);
  return { ...raw, schemaVersion: 1, web, mcpServers, plugins, markets };
}

export async function loadExtensions(p: DataPaths): Promise<ExtensionsFile> {
  let text: string;
  try {
    text = await fs.readFile(p.extensionsJson, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultExtensions();
    throw err;
  }
  try {
    return migrate(JSON.parse(text));
  } catch {
    // 坏文件先备份，之后保存覆盖时不丢原内容
    await fs.copyFile(p.extensionsJson, `${p.extensionsJson}.bad`).catch(() => {});
    return defaultExtensions();
  }
}

export async function saveExtensions(p: DataPaths, f: ExtensionsFile): Promise<void> {
  await atomicWriteFile(p.extensionsJson, `${JSON.stringify(f, null, 2)}\n`);
}
