import { promises as fs } from 'node:fs';
import { atomicWriteFile } from '../fs/atomic-write.ts';
import { sha256, withPathLock } from '../fs/lock.ts';
import { isValidTopicFile } from '../memory/topics.ts';
import { REDACTED } from '../secrets/redact.ts';
import { isInside } from './path-guard.ts';
import type { FileCtx, ToolOutput } from './types.ts';

export const ERR_STALE = '文件在读取后已被修改，或本线程尚未读取过它。请先用 read_file 重新读取。';
export const ERR_PLACEHOLDER =
  '包含已脱敏占位符 [REDACTED_API_KEY]，禁止写回；请用 edit_file 只修改不含密钥的行。';
export const ERR_SECRET_IN_MEMORY = '记忆与用户画像中不得包含 API Key。';
export const ERR_TOPIC_PATH =
  '记忆文件必须是 memory/ 下的 <主题>.md（不能有子目录，主题名不能含 \\ / : * ? " < > |）。';

const MAX_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const BINARY_CHECK_BYTES = 8192;
/** 超过这个大小的文件整个读进内存再切行不划算，也放不进上下文 */
export const MAX_READ_BYTES = 10 * 1024 * 1024;

function fail(content: string): ToolOutput {
  return { content, isError: true };
}

function memoryKind(ctx: FileCtx, real: string): 'user' | 'bot' | null {
  if (isInside(real, ctx.paths.userMd)) return 'user';
  if (isInside(real, ctx.paths.memoryDir(ctx.actor))) return 'bot';
  return null;
}

async function readExisting(real: string): Promise<{ bytes: Buffer; hash: string } | null> {
  try {
    const bytes = await fs.readFile(real);
    return { bytes, hash: sha256(bytes) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export async function readFile(
  ctx: FileCtx,
  real: string,
  a: { offset?: number; limit?: number },
): Promise<ToolOutput> {
  let bytes: Buffer;
  try {
    const { size } = await fs.stat(real);
    if (size > MAX_READ_BYTES) {
      return fail(`文件太大（${Math.ceil(size / 1024 / 1024)} MB，上限 ${MAX_READ_BYTES / 1024 / 1024} MB），请用 grep 搜索需要的部分。`);
    }
    bytes = await fs.readFile(real);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fail('文件不存在。');
    throw err;
  }

  if (
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  ) {
    return fail('文件是 UTF-16 编码，暂不支持，请另存为 UTF-8 后再读取。');
  }
  if (bytes.subarray(0, BINARY_CHECK_BYTES).includes(0)) {
    return fail('文件看起来是二进制文件，暂不支持读取。');
  }
  const text = decodeUtf8(bytes);
  if (text === null) return fail('文件不是 UTF-8 编码，无法读取。');

  ctx.tracker.record(real, sha256(bytes));

  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  const start = Math.max(1, Math.trunc(a.offset ?? 1));
  const limit = Math.min(Math.max(1, Math.trunc(a.limit ?? MAX_READ_LINES)), MAX_READ_LINES);
  const from = Math.min(start, total);
  const to = Math.min(total, start + limit - 1);

  const output: string[] = [];
  for (let i = from - 1; i < to; i += 1) {
    let line = lines[i] ?? '';
    if (line.length > MAX_LINE_CHARS) {
      line = `${line.slice(0, MAX_LINE_CHARS)}…[本行已截断]`;
    }
    output.push(`${i + 1}\t${line}`);
  }
  if (from !== 1 || to !== total) {
    output.push(`[文件共 ${total} 行，已显示 ${from}–${to} 行]`);
  }
  return { content: output.join('\n'), isError: false };
}

export async function writeFile(
  ctx: FileCtx,
  real: string,
  a: { content: string },
): Promise<ToolOutput> {
  return withPathLock(real, async () => {
    const existing = await readExisting(real);
    if (existing !== null) {
      const seen = ctx.tracker.get(real);
      if (seen === undefined || seen !== existing.hash) return fail(ERR_STALE);
    }
    if (a.content.includes(REDACTED)) return fail(ERR_PLACEHOLDER);

    const kind = memoryKind(ctx, real);
    if (kind !== null && ctx.secrets.containsKnown(a.content)) return fail(ERR_SECRET_IN_MEMORY);
    if (kind === 'bot' && !isValidTopicFile(real, ctx.paths.memoryDir(ctx.actor))) {
      return fail(ERR_TOPIC_PATH);
    }

    if (kind !== null) await ctx.revisions.write(real, a.content, ctx.actor, 'chat');
    else await atomicWriteFile(real, a.content);
    ctx.tracker.record(real, sha256(a.content));
    return { content: '已写入。', isError: false };
  });
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

export async function editFile(
  ctx: FileCtx,
  real: string,
  a: { old_string: string; new_string: string; replace_all?: boolean },
): Promise<ToolOutput> {
  return withPathLock(real, async () => {
    const existing = await readExisting(real);
    if (existing === null) return fail('文件不存在，无法编辑。');
    const seen = ctx.tracker.get(real);
    if (seen === undefined || seen !== existing.hash) return fail(ERR_STALE);

    const text = decodeUtf8(existing.bytes);
    if (text === null) return fail('文件不是 UTF-8 编码，无法编辑。');
    if (a.old_string.length === 0) return fail('old_string 不能为空。');
    if (a.old_string.includes(REDACTED) || a.new_string.includes(REDACTED)) {
      return fail(ERR_PLACEHOLDER);
    }

    let oldString = a.old_string;
    let newString = a.new_string;
    if (text.includes('\r\n') && !text.includes(oldString)) {
      oldString = oldString.replace(/\r?\n/g, '\r\n');
      newString = newString.replace(/\r?\n/g, '\r\n');
    }

    const count = countOccurrences(text, oldString);
    if (count === 0) return fail('未找到要替换的文本。');
    if (count > 1 && a.replace_all !== true) {
      return fail(`要替换的文本出现 ${count} 次，请提供更多上下文或使用 replace_all。`);
    }
    const next =
      a.replace_all === true
        ? text.split(oldString).join(newString)
        : text.replace(oldString, () => newString);

    const kind = memoryKind(ctx, real);
    if (kind !== null && ctx.secrets.containsKnown(next)) return fail(ERR_SECRET_IN_MEMORY);
    if (kind === 'bot' && !isValidTopicFile(real, ctx.paths.memoryDir(ctx.actor))) {
      return fail(ERR_TOPIC_PATH);
    }

    if (kind !== null) await ctx.revisions.write(real, next, ctx.actor, 'chat');
    else await atomicWriteFile(real, next);
    ctx.tracker.record(real, sha256(next));
    return { content: '已修改。', isError: false };
  });
}
