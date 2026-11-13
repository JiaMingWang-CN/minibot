// skill 的发现与校验（扩展第 5 期 Task 1）。遵循 agentskills.io 规范：
// 目录里有 SKILL.md，frontmatter 必填 name 与 description。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export type SkillOrigin = { kind: 'user' } | { kind: 'plugin'; pluginName: string };

export interface SkillInfo {
  /** 单独添加：user:<name>；插件：plugin:<pluginName>:<name> */
  id: string;
  name: string;
  description: string;
  dir: string;
  origin: SkillOrigin;
  /** 与单独添加的同名 skill 冲突时为 true（不可用） */
  shadowed: boolean;
}

export interface SkillProblem {
  dir: string;
  reason: string;
}

export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SKILL_NAME_RULE = '1–64 位小写字母、数字、连字符，不以连字符开头或结尾，不含 --';
const DESCRIPTION_MAX = 1024;

export function skillId(origin: SkillOrigin, name: string): string {
  return origin.kind === 'user' ? `user:${name}` : `plugin:${origin.pluginName}:${name}`;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 去掉 BOM、统一换行后按 --- 行切分 frontmatter 与正文 */
export function splitFrontmatter(text: string): { frontmatter: string; body: string } | null {
  const normalized = stripBom(text).replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length === 0 || lines[0]!.trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');
  return { frontmatter: lines.slice(1, end).join('\n'), body };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 读 SKILL.md 并校验；不合规时抛出带原因的 Error */
export async function readSkill(dir: string, origin: SkillOrigin): Promise<SkillInfo> {
  const resolved = path.resolve(dir);
  const basename = path.basename(resolved);
  let text: string;
  try {
    text = await fs.readFile(path.join(resolved, 'SKILL.md'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('缺少 SKILL.md');
    throw err;
  }
  const parts = splitFrontmatter(text);
  if (parts === null) throw new Error('缺少 frontmatter');
  let data: unknown;
  try {
    data = parseYaml(parts.frontmatter);
  } catch (err) {
    throw new Error(`frontmatter 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(data)) throw new Error('缺少 frontmatter');

  const name = typeof data['name'] === 'string' ? data['name'] : '';
  if (name.length === 0 || name.length > 64 || !SKILL_NAME_RE.test(name)) {
    throw new Error(`name 不合规：${SKILL_NAME_RULE}`);
  }
  if (name !== basename) throw new Error('name 必须与目录名一致');

  const description = typeof data['description'] === 'string' ? data['description'] : '';
  if (description.length < 1 || description.length > DESCRIPTION_MAX) {
    throw new Error('description 必须是 1–1024 个字符');
  }
  // allowed-tools 读取后忽略，不改变任何审批

  return { id: skillId(origin, name), name, description, dir: resolved, origin, shadowed: false };
}

/** 读取 SKILL.md 正文（去掉 frontmatter） */
export async function readSkillBody(dir: string): Promise<string> {
  const text = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
  const parts = splitFrontmatter(text);
  return parts === null ? stripBom(text) : parts.body;
}
