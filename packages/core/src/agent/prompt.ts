import type { Bot } from '../config/types.ts';

export interface SystemPromptArgs {
  bot: Bot;
  workspace: string;
  userMd: string;
  userMdPath: string;
  memoryDir: string;
  topics: { name: string; summary: string | null }[];
  skills?: { name: string; description: string }[];
  platform: NodeJS.Platform;
  now: Date;
}

const SKILL_SUMMARY_MAX = 8000;
const SKILL_CONVENTION = '任务和某个 skill 相关时，先调用 load_skill 读取说明再动手。';

// 只精确到天：系统提示在请求最前面，时间戳每变一次，各家的前缀缓存就整体失效
function localDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 可用 skill 摘要；总长超过 8000 字符时按顺序截断并注明还有多少未列出 */
export function skillSummary(skills: { name: string; description: string }[]): string {
  const lines = skills.map((s) => `- ${s.name}：${s.description}`);
  const build = (shown: number, extra: string | null): string =>
    ['可用的 skill：', ...lines.slice(0, shown), ...(extra === null ? [] : [extra]), SKILL_CONVENTION].join('\n');
  let shown = lines.length;
  let text = build(shown, null);
  while (text.length > SKILL_SUMMARY_MAX && shown > 0) {
    shown -= 1;
    text = build(shown, `（还有 ${lines.length - shown} 个 skill 未列出，可用 load_skill 按名字读取）`);
  }
  return text;
}

export function buildSystemPrompt(a: SystemPromptArgs): string {
  const parts: string[] = [
    `${a.bot.persona}

当前工作目录：${a.workspace}
当前平台：${a.platform}
当前日期：${localDate(a.now)}

用户画像（${a.userMdPath}）：
${a.userMd.length > 0 ? a.userMd : '（暂无）'}`,
  ];
  if (a.bot.memoryEnabled) {
    const topicLines =
      a.topics.length === 0
        ? '（暂无主题）'
        : a.topics.map((t) => `- ${t.name}：${t.summary ?? '无简介'}`).join('\n');
    parts.push(`记忆主题（${a.memoryDir}）：
${topicLines}

记忆约定：
- 每个主题文件的第一行必须是 “> 简介：<一句话简介>”；新建主题文件时必须先写这一行，简介要与正文同步更新。
- 主题文件放在上述记忆目录中，文件名（去掉 .md）就是主题名，不能有子目录。
- 用户说“记住”时，请把内容写入对应的主题记忆文件或用户画像。
- 用户画像所有 bot 共享；主题记忆只属于当前 bot。`);
  }
  if (a.skills !== undefined && a.skills.length > 0) parts.push(skillSummary(a.skills));
  return parts.join('\n\n');
}

