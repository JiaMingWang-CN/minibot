import { promises as fs } from 'node:fs';
import path from 'node:path';

export const TOPIC_HEADER_RE = /^\uFEFF?>\s*简介\s*[:：]\s*(.+?)\r?$/;

export function parseTopicHeader(firstLine: string): string | null {
  const match = TOPIC_HEADER_RE.exec(firstLine);
  if (match === null) return null;
  const summary = (match[1] ?? '').trim();
  return summary.length === 0 ? null : summary;
}

export function isValidTopicFile(
  real: string,
  memoryDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const caseInsensitive = platform === 'win32';
  const normalize = (p: string): string => {
    const resolved = path.resolve(p);
    return caseInsensitive ? resolved.toLowerCase() : resolved;
  };
  const dir = normalize(memoryDir);
  const file = normalize(real);
  if (path.dirname(file) !== dir) return false;
  const base = path.basename(file);
  if (!base.toLowerCase().endsWith('.md')) return false;
  const topic = base.slice(0, -3);
  return /^[^\\/:*?"<>|\r\n]{1,64}$/.test(topic);
}

export interface TopicEntry {
  name: string;
  summary: string | null;
  path: string;
}

export async function buildTopicIndex(memoryDir: string): Promise<TopicEntry[]> {
  let entries;
  try {
    entries = await fs.readdir(memoryDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const names = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => e.name)
    .sort();
  const topics: TopicEntry[] = [];
  for (const name of names) {
    const filePath = path.join(memoryDir, name);
    let summary: string | null = null;
    try {
      const fh = await fs.open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(4096);
        const { bytesRead } = await fh.read(buffer, 0, 4096, 0);
        const text = buffer.subarray(0, bytesRead).toString('utf8');
        const firstLine = text.split('\n', 1)[0] ?? '';
        summary = parseTopicHeader(firstLine);
      } finally {
        await fh.close();
      }
    } catch {
      summary = null;
    }
    topics.push({ name: name.slice(0, -3), summary, path: filePath });
  }
  return topics;
}
