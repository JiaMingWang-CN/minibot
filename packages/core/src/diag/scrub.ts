// 上传前的脱敏：路径、堆栈、以及形似密钥的字符串。

export interface PathContext {
  home: string;
  workspaces: string[];
  user: string;
  host: string;
}

/** 名字过短（如 1~2 个字符的用户名）按词替换会误伤普通文字，不处理 */
const MIN_NAME_LENGTH = 3;
const STACK_MAX_CHARS = 4096;
const REDACTED_SHAPE = '[REDACTED]';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** 目录前缀的匹配式：分隔符正反斜杠通用（含 JSON 转义后的双反斜杠），Windows 路径不分大小写 */
function prefixRegex(dir: string): RegExp | null {
  const windows = isWindowsPath(dir);
  const segments = dir.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  const lead = !windows && dir.startsWith('/') ? '/' : '';
  const body = segments.map(escapeRegExp).join('[\\\\/]{1,2}');
  // 前面不能紧贴名字字符，后面不能接着名字字符（避免 Alice 误伤 Alice2）
  return new RegExp(`(?<![A-Za-z0-9_])${lead}${body}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, windows ? 'gi' : 'g');
}

function wordRegex(name: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, 'gi');
}

/** 主目录 → ~，工作区根 → <workspace>，用户名 → <user>，主机名 → <host> */
export function scrubPaths(text: string, ctx: PathContext): string {
  let out = text;
  const workspaces = [...ctx.workspaces].filter((w) => w.length > 0).sort((a, b) => b.length - a.length);
  for (const workspace of workspaces) {
    const re = prefixRegex(workspace);
    if (re !== null) out = out.replace(re, '<workspace>');
  }
  if (ctx.home.length > 0) {
    const re = prefixRegex(ctx.home);
    if (re !== null) out = out.replace(re, '~');
  }
  // 主机名常含用户名（ALICE-PC），先换更长的
  if (ctx.host.length >= MIN_NAME_LENGTH) out = out.replace(wordRegex(ctx.host), '<host>');
  if (ctx.user.length >= MIN_NAME_LENGTH) out = out.replace(wordRegex(ctx.user), '<user>');
  return out;
}

const ABSOLUTE = /^(?:file:\/\/\/?)?(?:[A-Za-z]:[\\/]|\\\\|\/)/;
const POSITION = /^(.*?)((?::\d+){1,2})$/;
const MARKERS = ['/app.asar/', '/packages/', '/node_modules/'];

/** 绝对路径只保留 app.asar/、packages/、node_modules/ 之后的部分，找不到标记就只留文件名 */
function relativeLocation(location: string): string {
  if (!ABSOLUTE.test(location)) return location;
  const match = POSITION.exec(location);
  const pathPart = match === null ? location : match[1]!;
  const position = match === null ? '' : match[2]!;
  let normalized = pathPart.replace(/\\/g, '/');
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // 不是合法的 URL 转义，原样处理
  }
  for (const marker of MARKERS) {
    const index = normalized.indexOf(marker);
    if (index >= 0) return normalized.slice(index + 1) + position;
  }
  const slash = normalized.lastIndexOf('/');
  return normalized.slice(slash + 1) + position;
}

const FRAME = /^\s*at\s+(?:(.+?)\s+\((.+)\)|(.+?))\s*$/;

/** 只保留栈帧：每帧留函数名与相对源码位置；错误消息行丢弃（可能含用户内容）；总长封顶 4096 字符 */
export function scrubStack(stack: string, ctx: PathContext): string {
  const frames: string[] = [];
  let total = 0;
  for (const line of stack.split(/\r?\n/)) {
    const match = FRAME.exec(line);
    if (match === null) continue;
    const fn = match[1];
    const location = relativeLocation(match[2] ?? match[3] ?? '');
    const frame = scrubPaths(fn === undefined ? `at ${location}` : `at ${fn} (${location})`, ctx);
    if (total + frame.length + (frames.length > 0 ? 1 : 0) > STACK_MAX_CHARS) break;
    total += frame.length + (frames.length > 0 ? 1 : 0);
    frames.push(frame);
  }
  return frames.join('\n');
}

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SK_KEY = /\bsk-[A-Za-z0-9_-]{8,}/g;
// 32 位以上、同时含字母和数字的连续字符：像随机生成的令牌。
// UUID / bot id（8-4-4-4-12 的十六进制）不是密钥，保留原样以便排查。
const UUID_SHAPE = /[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}/;
const LONG_TOKEN = /(?<![A-Za-z0-9_+-])(?=[A-Za-z0-9_+-]*\d)(?=[A-Za-z0-9_+-]*[A-Za-z])[A-Za-z0-9_+-]{32,}/g;

/** 没登记过的密钥的形态过滤：sk-…、Bearer …、长随机串 → [REDACTED] */
export function redactLike(text: string): string {
  return text
    .replace(BEARER, REDACTED_SHAPE)
    .replace(SK_KEY, REDACTED_SHAPE)
    .replace(LONG_TOKEN, (token) => (UUID_SHAPE.test(token) ? token : REDACTED_SHAPE));
}
