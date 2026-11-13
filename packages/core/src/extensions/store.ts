import { promises as fs } from 'node:fs';
import { atomicWriteFile } from '../fs/atomic-write.ts';
import type { DataPaths } from '../paths.ts';

export type SearchEngine = 'none' | 'deepseek' | 'tavily';

export interface WebSettings {
  fetchEnabled: boolean;
  searchEngine: SearchEngine;
}

/** 扩展的全局设置；后续各期往里加字段，读写时保留不认识的字段 */
export interface ExtensionsFile {
  schemaVersion: 1;
  web: WebSettings;
  [key: string]: unknown;
}

const ENGINES: readonly SearchEngine[] = ['none', 'deepseek', 'tavily'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function defaultExtensions(): ExtensionsFile {
  return { schemaVersion: 1, web: { fetchEnabled: true, searchEngine: 'none' } };
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
  return { ...raw, schemaVersion: 1, web };
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
