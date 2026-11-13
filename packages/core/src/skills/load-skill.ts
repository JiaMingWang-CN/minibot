// 内置工具 load_skill：按需读取某个 skill 的说明或引用文件（扩展第 5 期 Task 2）。

import { promises as fs } from 'node:fs';
import type { ToolSpec } from '../model/adapter.ts';
import { MAX_READ_BYTES } from '../tools/files.ts';
import { isInside, resolveReal } from '../tools/path-guard.ts';
import { readSkillBody, type SkillInfo } from './skill.ts';

export const LOAD_SKILL_SPEC: ToolSpec = {
  name: 'load_skill',
  description: '读取某个 skill 的说明。先不带 path 读 SKILL.md 正文；需要参考文件时再传 path。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'skill 名称' },
      path: { type: 'string', description: 'skill 目录内的相对路径，如 references/a.md' },
    },
    required: ['name'],
  },
};

/** load_skill 与点名共用的正文格式：第一行目录，空行，SKILL.md 正文 */
export function formatSkillBody(info: SkillInfo, body: string): string {
  return `skill 目录：${info.dir}\n\n${body}`;
}

function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 4096);
  for (let i = 0; i < limit; i += 1) if (buf[i] === 0) return true;
  return false;
}

/** 在给定可用 skill 中读取；path 越界、非文本、超大都按固定文案报错 */
export async function loadSkill(skills: SkillInfo[], input: Record<string, unknown>): Promise<string> {
  const name = input['name'];
  if (typeof name !== 'string') throw new Error('参数错误：name 必须是字符串。');
  const info = skills.find((skill) => skill.name === name && !skill.shadowed);
  if (info === undefined) throw new Error(`没有这个 skill：${name}`);

  const relative = input['path'];
  if (relative === undefined) {
    return formatSkillBody(info, await readSkillBody(info.dir));
  }
  if (typeof relative !== 'string') throw new Error('参数错误：path 必须是字符串。');

  const base = await resolveReal(info.dir, info.dir);
  const target = await resolveReal(relative, info.dir);
  if (!isInside(target, base)) throw new Error('路径超出 skill 目录');
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new Error('文件不存在');
  }
  if (!stat.isFile()) throw new Error('不是文本文件');
  if (stat.size > MAX_READ_BYTES) throw new Error('文件太大（上限 10 MB）');
  const buf = await fs.readFile(target);
  if (looksBinary(buf)) throw new Error('不是文本文件');
  return buf.toString('utf8');
}
