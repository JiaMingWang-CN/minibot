import type { Bot } from '../config/types.ts';

export interface SystemPromptArgs {
  bot: Bot;
  workspace: string;
  userMd: string;
  userMdPath: string;
  memoryDir: string;
  topics: { name: string; summary: string | null }[];
  platform: NodeJS.Platform;
  now: Date;
}

export function buildSystemPrompt(a: SystemPromptArgs): string {
  const head = `${a.bot.persona}

当前工作目录：${a.workspace}
当前平台：${a.platform}
当前时间：${a.now.toISOString()}

用户画像（${a.userMdPath}）：
${a.userMd.length > 0 ? a.userMd : '（暂无）'}`;
  if (!a.bot.memoryEnabled) return head;
  const topicLines =
    a.topics.length === 0
      ? '（暂无主题）'
      : a.topics.map((t) => `- ${t.name}：${t.summary ?? '无简介'}`).join('\n');
  return `${head}

记忆主题（${a.memoryDir}）：
${topicLines}

记忆约定：
- 每个主题文件的第一行必须是 “> 简介：<一句话简介>”；新建主题文件时必须先写这一行，简介要与正文同步更新。
- 主题文件放在上述记忆目录中，文件名（去掉 .md）就是主题名，不能有子目录。
- 用户说“记住”时，请把内容写入对应的主题记忆文件或用户画像。
- 用户画像所有 bot 共享；主题记忆只属于当前 bot。`;
}
