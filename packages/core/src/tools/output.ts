import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const OUTPUT_LIMIT = 30_000;
export const OUTPUT_KEEP = 15_000;
export const OUTPUT_RETENTION_MS = 7 * 24 * 3600 * 1000;

async function pruneOutputs(dir: string): Promise<void> {
  const cutoff = Date.now() - OUTPUT_RETENTION_MS;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = await fs.stat(file);
      if (stat.isFile() && stat.mtimeMs < cutoff) await fs.unlink(file);
    } catch {
      // 清理失败不影响结果
    }
  }
}

/**
 * 统一的结果截断：不超过上限原样返回；超过时保留头尾各 OUTPUT_KEEP，完整内容写入 outputs 目录并告诉模型路径。
 * run_command 与外部工具共用同一规则。
 */
export async function clipToOutputs(text: string, outputsDir: string): Promise<string> {
  if (text.length <= OUTPUT_LIMIT) return text;
  await fs.mkdir(outputsDir, { recursive: true });
  await pruneOutputs(outputsDir);
  const fileName = `output-${Date.now()}-${randomBytes(4).toString('hex')}.txt`;
  const fullPath = path.join(outputsDir, fileName);
  await fs.writeFile(fullPath, text, 'utf8');
  const omitted = text.length - OUTPUT_LIMIT;
  return `${text.slice(0, OUTPUT_KEEP)}[已省略中间 ${omitted} 个字符，完整输出见 ${fullPath}]\n${text.slice(-OUTPUT_KEEP)}`;
}
