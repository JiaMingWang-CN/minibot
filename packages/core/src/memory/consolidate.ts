import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Bot, Provider } from '../config/types.ts';
import type { CallModel } from '../model/client.ts';
import { transcriptMessage, transcriptOf } from '../agent/transcript.ts';
import { estimateChars } from '../agent/compaction.ts';
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

/** 一批对话 + 系统提示 + 现有记忆最多占整理模型窗口的比例，其余留给输出与估算误差 */
const WINDOW_USE_RATIO = 0.9;
/** 给输出预留的窗口比例上限（maxOutputTokens 很大时不至于把输入挤没） */
const OUTPUT_RESERVE_RATIO = 0.25;

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
  /** contextWindow / maxOutputTokens 是整理所用模型的，不一定是 bot 自己的 */
  resolveConsolidationModel: (bot: Bot) => {
    provider: Provider;
    apiKey: string;
    model: string;
    contextWindow: number;
    maxOutputTokens: number;
  };
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
  private abort = new AbortController();
  private inflight = new Set<Promise<void>>();

  constructor(deps: ConsolidatorDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      this.scan().catch((err: unknown) => {
        console.warn('后台整理扫描失败', err);
      });
    }, SCAN_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** 停止定时扫描、中止进行中的整理并等它结束；之后不再接受新的整理 */
  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.abort.abort();
    await Promise.allSettled([...this.inflight]);
  }

  async scan(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const bots = await listBots(this.deps.paths);
    for (const bot of bots) {
      if (this.abort.signal.aborted) return;
      if (!bot.memoryEnabled) continue;
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
    if (this.abort.signal.aborted) return;
    const job = this.consolidateOnce(threadId);
    this.inflight.add(job);
    try {
      await job;
    } finally {
      this.inflight.delete(job);
    }
  }

  private async consolidateOnce(threadId: string): Promise<void> {
    const thread = getThread(this.deps.db, threadId);
    if (thread === null) return;
    const bot = await this.deps.loadBot(thread.botId);
    if (!bot.memoryEnabled) return;
    const all = messagesFrom(this.deps.db, threadId, thread.lastExtractedMsgId + 1);
    if (all.length === 0) return;
    const latestId = all[all.length - 1]!.id;

    let incremental: StoredMessage[];
    let replyText: string;
    let files: MemoryFile[];
    try {
      const info = this.deps.resolveConsolidationModel(bot);
      files = await this.readMemoryFiles(bot);
      incremental = takeBatch(all, info.contextWindow, info.maxOutputTokens, this.systemPrompt(bot, files));
      replyText = await this.callConsolidationModel(bot, incremental, files, info);
    } catch {
      this.failed.set(threadId, latestId);
      return;
    }
    // 这一批的末尾；超长的增量剩下的部分留给下次扫描
    const batchEndId = incremental[incremental.length - 1]!.id;
    if (this.abort.signal.aborted) return;

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
      updateThread(this.deps.db, threadId, { lastExtractedMsgId: batchEndId });
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

  private systemPrompt(bot: Bot, files: MemoryFile[]): string {
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
    return `${PROMPT_RULES}\n\n现有记忆文件：\n${fileText}`;
  }

  private async callConsolidationModel(
    bot: Bot,
    incremental: StoredMessage[],
    files: MemoryFile[],
    info: { provider: Provider; apiKey: string; model: string; maxOutputTokens: number },
  ): Promise<string> {
    const result = await this.deps.callModel({
      provider: info.provider,
      apiKey: info.apiKey,
      request: {
        model: info.model,
        system: this.systemPrompt(bot, files),
        messages: [
          transcriptMessage(
            incremental[0]?.threadId ?? '',
            '以下是新增的对话记录。请按系统提示的规则整理记忆，只返回 JSON。',
            incremental,
          ),
        ],
        tools: [],
        maxTokens: info.maxOutputTokens,
        thinkingLevel: null,
      },
      signal: this.abort.signal,
      onDelta: () => {},
    });
    return result.blocks
      .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }

  private validateTargets(bot: Bot, reply: ConsolidationReply): WriteTarget[] {
    const targets: WriteTarget[] = [];
    if (reply.user !== null && reply.user.trim().length > 0 && !this.deps.secrets.containsKnown(reply.user)) {
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

/** 从增量开头取一段放得进整理模型窗口的消息（至少一条）；超出的留给下次 */
function takeBatch(
  messages: StoredMessage[],
  contextWindow: number,
  maxOutputTokens: number,
  system: string,
): StoredMessage[] {
  const reserve = Math.min(maxOutputTokens, contextWindow * OUTPUT_RESERVE_RATIO);
  let budget = contextWindow * WINDOW_USE_RATIO - reserve - estimateChars(system);
  const batch: StoredMessage[] = [];
  for (const message of messages) {
    const size = estimateChars(transcriptOf([message]));
    if (batch.length > 0 && size > budget) break;
    batch.push(message);
    budget -= size;
  }
  return batch;
}

function latestMessageId(db: DatabaseSync, threadId: string): number | null {
  const row = db.prepare('SELECT MAX(id) AS id FROM messages WHERE thread_id = ?').get(threadId) as
    | { id: number | null }
    | undefined;
  return row?.id ?? null;
}

async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}
