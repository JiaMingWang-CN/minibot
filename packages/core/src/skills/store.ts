// skill 存储：扫描、添加、删除（扩展第 5 期 Task 1）。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DataPaths } from '../paths.ts';
import { SKILL_NAME_RE, readSkill, readSkillBody, type SkillInfo, type SkillProblem } from './skill.ts';

export interface PluginSkillDirs {
  pluginName: string;
  dirs: string[];
}

export interface SkillServiceOptions {
  paths: DataPaths;
  loadPluginSkillDirs: () => Promise<PluginSkillDirs[]>;
  enableForMainBot: (kind: 'skills', id: string) => Promise<void>;
  removeFromAllBots: (kind: 'skills', id: string) => Promise<void>;
}

async function copyTree(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await fs.copyFile(from, to);
  }
}

export class SkillService {
  private readonly opts: SkillServiceOptions;

  constructor(options: SkillServiceOptions) {
    this.opts = options;
  }

  async list(): Promise<{ skills: SkillInfo[]; problems: SkillProblem[] }> {
    const skills: SkillInfo[] = [];
    const problems: SkillProblem[] = [];
    const userNames = new Set<string>();

    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(this.opts.paths.skillsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.opts.paths.skillsDir, entry.name);
      try {
        const info = await readSkill(dir, { kind: 'user' });
        skills.push(info);
        userNames.add(info.name);
      } catch (err) {
        problems.push({ dir, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    for (const group of await this.opts.loadPluginSkillDirs()) {
      for (const dir of group.dirs) {
        try {
          const info = await readSkill(dir, { kind: 'plugin', pluginName: group.pluginName });
          info.shadowed = userNames.has(info.name);
          skills.push(info);
        } catch (err) {
          problems.push({ dir, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return { skills, problems };
  }

  async add(srcDir: string): Promise<SkillInfo> {
    const info = await readSkill(srcDir, { kind: 'user' });
    const target = path.join(this.opts.paths.skillsDir, info.name);
    if (await fs.stat(target).then(() => true, () => false)) throw new Error(`已有同名 skill：${info.name}`);
    await fs.mkdir(this.opts.paths.skillsDir, { recursive: true });
    await copyTree(info.dir, target);
    await this.opts.enableForMainBot('skills', info.id);
    return { ...info, dir: target };
  }

  async remove(id: string): Promise<void> {
    if (!id.startsWith('user:')) throw new Error('只能删除单独添加的 skill');
    const name = id.slice('user:'.length);
    if (name.length === 0 || name.length > 64 || !SKILL_NAME_RE.test(name)) throw new Error('skill 名称不合规');
    await fs.rm(path.join(this.opts.paths.skillsDir, name), { recursive: true, force: true });
    await this.opts.removeFromAllBots('skills', id);
  }

  async body(id: string): Promise<{ dir: string; body: string }> {
    const { skills } = await this.list();
    const info = skills.find((skill) => skill.id === id && !skill.shadowed);
    if (info === undefined) throw new Error(`没有这个 skill：${id}`);
    return { dir: info.dir, body: await readSkillBody(info.dir) };
  }
}
