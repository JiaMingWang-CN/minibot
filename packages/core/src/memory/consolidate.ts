import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Bot, Provider } from '../config/types.ts';
import type { CallModel } from '../model/client.ts';
import { transcriptMessage } from '../agent/transcript.ts';
import type { Block, StoredMessage } from '../model/types.ts';
import { messagesFrom } from '../db/messages.ts';
import { getThread, listThreads, updateThread } from '../db/threads.ts';
import { listBots } from '../config/config.ts';
import type { DataPaths } from '../paths.ts';
import { sha256, withPathLock } from '../fs/lock.ts';
import type { MemoryRevisions } from './revisions.ts';
import { buildTopicIndex, isValidTopicFile, parseTopicHeader } from './topics.ts';
import type { SecretSet } from '../secrets/redact.ts';
import type { KernelEvent } from '../events.ts';

export const SCAN_INTERVAL_MS = 180_000;
export const IDLE_MS = 600_000;

const PROMPT_RULES = `你是 minibot 的记忆整理助手。

任务：阅读现有记忆文件与新增对话，只输出需要更新的文件内容。
规则：
1. 合并重复条目，保持文件精炼。
2. 新事实与旧记录冲突时直接覆盖旧条目，不要并列保留。
3. 每个主题文件内容的第一行必须是 “> 简介：<一句话简介>”，简介随正文变化同步更新。
4. 没有变化的文件不要输出；不要编造对话中没有的事实。
5. 只输出 JSON，不要输出任何其他文字。

输出格式：
{"user": string | null, "topics": [{"name": string, "content": string}]}

“user”是更新后的 user.md 全文；不需要更新时为 null。
“topics”只列出有变化的主题文件，name 是主题名（不含 .md），content 是文件全文。`;

export interface ConsolidatorDeps {
  db: DatabaseSync;
  paths: DataPaths;
  revisions: MemoryRevisions;
  secrets: SecretSet;
  callModel: CallModel;
  resolveConsolidationModel: (bot: Bot) => { provider: Provider; apiKey: string; model: string };
  loadBot: (id: string) => Promise<Bot>;
  isThreadRunning: (id: string) => boolean;
  emit: (e: KernelEvent) => void;
  now?: () => number;
}

interface MemoryFile {
  path: string;
  content: string;
  hash: string;
}

interface ConsolidationReply {
  user: string | null;
  topics: { name: string; content: string }[];
}

interface WriteTarget {
  path: string;
  content: string;
}

function extractJson(text: string): unknown | null {
  let body = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fence !== null) body = (fence[1] ?? '').trim();
  try {
    return JSON.parse(body);
  } catch {
    // 尝试从文本中截取第一个 JSON 对象
  }
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function firstLine(content: string): string {
  return content.split('\n', 1)[0] ?? '';
}

function parseReply(text: string): ConsolidationReply | null {
  const raw = extractJson(text);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const object = raw as Record<string, unknown>;
  let user: string | null = null;
  if (typeof object['user'] === 'string') user = object['user'];
  const topics: { name: string; content: string }[] = [];
  if (Array.isArray(object['topics'])) {
    for (const item of object['topics']) {
      if (
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>)['name'] === 'string' &&
        typeof (item as Record<string, unknown>)['content'] === 'string'
      ) {
        topics.push({
          name: (item as Record<string, unknown>)['name'] as string,
          content: (item as Record<string, unknown>)['content'] as string,
        });
      }
    }
  }
  return { user, topics };
}

export class Consolidator {
  private deps: ConsolidatorDeps;
  private timer: NodeJS.Timeout | undefined;
  private failed = new Map<string, number>();
  private runningBots = new Set<string>();

  constructor(deps: ConsolidatorDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.scan();
    }, SCAN_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  async scan(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const bots = await listBots(this.deps.paths);
    for (const bot of bots) {
      for (const thread of listThreads(this.deps.db, bot.id)) {
        const latest = latestMessageId(this.deps.db, thread.id);
        if (latest === null) continue;
        if (latest <= thread.lastExtractedMsgId) continue;
        if (thread.lastActivityAt > now - IDLE_MS) continue;
        if (this.deps.isThreadRunning(thread.id)) continue;
        const failedAt = this.failed.get(thread.id);
        if (failedAt !== undefined && latest <= failedAt) continue;
        if (this.runningBots.has(bot.id)) continue;
        this.runningBots.add(bot.id);
        try {
          await this.consolidateThread(thread.id);
        } catch {
          this.failed.set(thread.id, latest);
        } finally {
          this.runningBots.delete(bot.id);
        }
      }
    }
  }

  async consolidateThread(threadId: string): Promise<void> {
    const thread = getThread(this.deps.db, threadId);
    if (thread === null) return;
    const bot = await this.deps.loadBot(thread.botId);
    const incremental = messagesFrom(this.deps.db, threadId, thread.lastExtractedMsgId + 1);
    if (incremental.length === 0) return;
    const latestId = incremental[incremental.length - 1]!.id;

    let replyText: string;
    let files: MemoryFile[];
    try {
      files = await this.readMemoryFiles(bot);
      replyText = await this.callConsolidationModel(bot, incremental, files);
    } catch {
      this.failed.set(threadId, latestId);
      return;
    }

    const reply = parseReply(replyText);
    if (reply === null) {
      this.failed.set(threadId, latestId);
      return;
    }

    const targets = this.validateTargets(bot, reply);
    let conflict = false;
    for (const target of targets) {
      const captured = files.find((f) => f.path === target.path)?.hash ?? sha256('');
      const writeConflict = await withPathLock(target.path, async () => {
        const current = await readText(target.path);
        if (sha256(current) !== captured) return true;
        await this.deps.revisions.write(target.path, target.content, bot.id, 'consolidation');
        this.deps.emit({ type: 'memory_changed', path: target.path });
        return false;
      });
      if (writeConflict) conflict = true;
    }

    if (!conflict) {
      updateThread(this.deps.db, threadId, { lastExtractedMsgId: latestId });
      this.failed.delete(threadId);
    }
  }

  private async readMemoryFiles(bot: Bot): Promise<MemoryFile[]> {
    const userPath = this.deps.paths.userMd;
    const userContent = await readText(userPath);
    const files: MemoryFile[] = [{ path: userPath, content: userContent, hash: sha256(userContent) }];
    const topics = await buildTopicIndex(this.deps.paths.memoryDir(bot.id));
    for (const topic of topics) {
      const content = await readText(topic.path);
      files.push({ path: topic.path, content, hash: sha256(content) });
    }
    return files;
  }

  private async callConsolidationModel(
    bot: Bot,
    incremental: StoredMessage[],
    files: MemoryFile[],
  ): Promise<string> {
    const memoryDir = this.deps.paths.memoryDir(bot.id);
    const fileText = files
      .map((f) => {
        const label =
          f.path === this.deps.paths.userMd
            ? 'user.md'
            : `memory/${path.relative(memoryDir, f.path).split(path.sep).join('/')}`;
        return `=== ${label} ===\n${f.content}`;
      })
      .join('\n\n');
    const info = this.deps.resolveConsolidationModel(bot);
    const result = await this.deps.callModel({
      provider: info.provider,
      apiKey: info.apiKey,
      request: {
        model: info.model,
        system: `${PROMPT_RULES}\n\n现有记忆文件：\n${fileText}`,
        messages: [
          transcriptMessage(
            incremental[0]?.threadId ?? '',
            '以下是新增的对话记录。请按系统提示的规则整理记忆，只返回 JSON。',
            incremental,
          ),
        ],
        tools: [],
        maxTokens: bot.maxOutputTokens,
        thinkingLevel: null,
      },
      signal: new AbortController().signal,
      onDelta: () => {},
    });
    return result.blocks
      .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }

  private validateTargets(bot: Bot, reply: ConsolidationReply): WriteTarget[] {
    const targets: WriteTarget[] = [];
    if (reply.user !== null && !this.deps.secrets.containsKnown(reply.user)) {
      targets.push({ path: this.deps.paths.userMd, content: reply.user });
    }
    const memoryDir = this.deps.paths.memoryDir(bot.id);
    const seen = new Set<string>();
    for (const topic of reply.topics) {
      if (topic.name.length === 0 || seen.has(topic.name)) continue;
      const targetPath = path.join(memoryDir, `${topic.name}.md`);
      if (!isValidTopicFile(targetPath, memoryDir)) continue;
      if (parseTopicHeader(firstLine(topic.content)) === null) continue;
      if (this.deps.secrets.containsKnown(topic.content)) continue;
      seen.add(topic.name);
      targets.push({ path: targetPath, content: topic.content });
    }
    return targets;
  }
}

function latestMessageId(db: DatabaseSync, threadId: string): number | null {
  const messages = messagesFrom(db, threadId, 0);
  return messages.length === 0 ? null : messages[messages.length - 1]!.id;
}

async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}
