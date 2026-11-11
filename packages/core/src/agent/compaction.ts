import type { DatabaseSync } from 'node:sqlite';
import type { Bot, Provider } from '../config/types.ts';
import type { CallModel } from '../model/client.ts';
import type { Block, StoredMessage, Usage } from '../model/types.ts';
import { appendMessage, getMessage, messagesFrom } from '../db/messages.ts';
import { getThread, updateThread } from '../db/threads.ts';
import type { KernelEvent } from '../events.ts';
import { transcriptMessage } from './transcript.ts';

export const TRIM_PLACEHOLDER = '[已省略历史工具输出]';
export const SUMMARY_PREFIX = '以下是之前对话的摘要：';
export const SUMMARY_PROMPT =
  '把以下对话压缩成一份供你继续工作的摘要：保留用户目标、已做决定、未完成事项、关键文件路径和事实；不要编造。';

const FULL_COMPACT_RATIO = 0.8;
const MID_TURN_RATIO = 0.9;
const TRIM_RATIO = 0.7;
const KEEP_RATIO = 0.3;

export function estimateChars(text: string): number {
  const cjk = (text.match(/[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk * 1.2 + other / 3.5);
}

export function estimateTokens(
  system: string,
  messages: StoredMessage[],
  baseline?: { inputTokens: number; upToMsgId: number },
): number {
  if (baseline !== undefined && messages.some((m) => m.id === baseline.upToMsgId)) {
    const index = messages.findIndex((m) => m.id === baseline.upToMsgId);
    const after = messages.slice(index + 1);
    return baseline.inputTokens + estimateChars(JSON.stringify(after)) + imageTokens(after);
  }
  return estimateChars(`${system}${JSON.stringify(messages)}`) + imageTokens(messages);
}

/** 图片在消息里只存引用，按每张固定 token 数估算 */
export const IMAGE_TOKENS = 1600;

function imageTokens(messages: StoredMessage[]): number {
  let count = 0;
  for (const m of messages) for (const b of m.blocks) if (b.type === 'image') count += 1;
  return count * IMAGE_TOKENS;
}

export function contextFor(db: DatabaseSync, threadId: string): StoredMessage[] {
  const thread = getThread(db, threadId);
  if (thread === null) return [];
  if (thread.summaryMsgId === null) return messagesFrom(db, threadId, 0);
  const summary = getMessage(db, thread.summaryMsgId);
  const body = messagesFrom(db, threadId, thread.keepFromMsgId).filter(
    (m) => m.id !== thread.summaryMsgId,
  );
  return summary === null ? body : [summary, ...body];
}

export function trimToolResults(
  messages: StoredMessage[],
  budget: number,
  system: string,
): StoredMessage[] {
  const copy = structuredClone(messages);
  for (const message of copy) {
    for (const block of message.blocks) {
      if (
        block.type === 'tool_result' &&
        block.content.length > 1000 &&
        block.content !== TRIM_PLACEHOLDER
      ) {
        block.content = TRIM_PLACEHOLDER;
        if (estimateTokens(system, copy) <= budget) return copy;
      }
    }
  }
  return copy;
}

export interface CompactionDeps {
  db: DatabaseSync;
  callModel: CallModel;
  resolveModel: (bot: Bot) => { provider: Provider; apiKey: string };
  emit: (e: KernelEvent) => void;
  secrets?: { redact(text: string): string };
}

function isPureTextUser(message: StoredMessage): boolean {
  return (
    message.role === 'user' &&
    message.kind === null &&
    message.blocks.length > 0 &&
    message.blocks.every((b) => b.type === 'text')
  );
}

function chooseAutoBoundary(messages: StoredMessage[], contextWindow: number): number {
  const budget = contextWindow * KEEP_RATIO;
  let start = messages.length;
  let sum = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const size = estimateChars(JSON.stringify(messages[i]));
    if (start < messages.length && sum + size > budget) break;
    sum += size;
    start = i;
  }
  for (let i = Math.max(0, start); i >= 0; i -= 1) {
    const message = messages[i];
    if (message !== undefined && isPureTextUser(message)) return i;
  }
  return 0;
}

function bodyFor(db: DatabaseSync, threadId: string, summaryMsgId: number | null): StoredMessage[] {
  return messagesFrom(db, threadId, getThread(db, threadId)?.keepFromMsgId ?? 0).filter(
    (m) => m.id !== summaryMsgId,
  );
}

export async function compactThread(
  deps: CompactionDeps,
  bot: Bot,
  threadId: string,
  keepFromId: number | 'auto',
  signal: AbortSignal,
): Promise<void> {
  const thread = getThread(deps.db, threadId);
  if (thread === null) throw new Error('线程不存在');
  const summaryMessage =
    thread.summaryMsgId === null ? null : getMessage(deps.db, thread.summaryMsgId);
  const body = bodyFor(deps.db, threadId, thread.summaryMsgId);
  const combined = summaryMessage === null ? body : [summaryMessage, ...body];

  let boundaryIndex: number;
  if (keepFromId === 'auto') {
    boundaryIndex = chooseAutoBoundary(combined, bot.contextWindow);
  } else {
    const bodyIndex = body.findIndex((m) => m.id >= keepFromId);
    boundaryIndex = bodyIndex === -1 ? combined.length : (summaryMessage === null ? 0 : 1) + bodyIndex;
  }

  const toSummarize = combined.slice(0, boundaryIndex).filter((m) => m.kind !== 'notice');
  if (toSummarize.length === 0) return;
  let summaryText = '';
  let summaryUsage: Usage | undefined;
  {
    const info = deps.resolveModel(bot);
    const result = await deps.callModel({
      provider: info.provider,
      apiKey: info.apiKey,
      request: {
        model: bot.model,
        system: SUMMARY_PROMPT,
        messages: [transcriptMessage(threadId, '请为下面的对话记录生成摘要。', toSummarize)],
        tools: [],
        maxTokens: bot.maxOutputTokens,
        thinkingLevel: null,
      },
      signal,
      onDelta: () => {},
    });
    const text = result.blocks
      .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    summaryText = deps.secrets === undefined ? text : deps.secrets.redact(text);
    summaryUsage = result.usage;
  }
  if (summaryText.length === 0) summaryText = '（没有可压缩的对话）';

  const message = appendMessage(deps.db, {
    threadId,
    role: 'user',
    blocks: [{ type: 'text', text: `${SUMMARY_PREFIX}\n${summaryText}` }],
    kind: 'summary',
    interrupted: false,
    // 摘要调用也计入线程用量
    ...(summaryUsage !== undefined && summaryUsage.inputTokens > 0 ? { usage: summaryUsage } : {}),
  });
  deps.emit({ type: 'message', threadId, message });

  let keepMessageId: number;
  if (boundaryIndex < combined.length) {
    keepMessageId = combined[boundaryIndex]!.id;
  } else {
    const maxId = combined.reduce((max, m) => Math.max(max, m.id), 0);
    keepMessageId = maxId + 1;
  }
  updateThread(deps.db, threadId, {
    summaryMsgId: message.id,
    keepFromMsgId: keepMessageId,
  });
}

export function makePrepareContext(
  deps: CompactionDeps,
  onCompacted: (threadId: string) => void,
): (
  threadId: string,
  bot: Bot,
  signal: AbortSignal,
  turnStartId: number,
  system?: string,
) => Promise<StoredMessage[] | null> {
  return async (threadId, bot, signal, turnStartId, system = '') => {
    const thread = getThread(deps.db, threadId);
    if (thread === null) throw new Error('线程不存在');
    const window = bot.contextWindow;
    let context = contextFor(deps.db, threadId);
    let basis =
      thread.lastInputTokens !== null && thread.lastInputMsgId !== null
        ? { inputTokens: thread.lastInputTokens, upToMsgId: thread.lastInputMsgId }
        : undefined;
    let estimate = estimateTokens(system, context, basis);
    const lastId = context[context.length - 1]?.id;

    if (lastId === turnStartId && estimate > window * FULL_COMPACT_RATIO) {
      await compactThread(deps, bot, threadId, 'auto', signal);
      onCompacted(threadId);
      const updated = getThread(deps.db, threadId);
      context = contextFor(deps.db, threadId);
      basis =
        updated !== null && updated.lastInputTokens !== null && updated.lastInputMsgId !== null
          ? { inputTokens: updated.lastInputTokens, upToMsgId: updated.lastInputMsgId }
          : undefined;
      estimate = estimateTokens(system, context, basis);
    }

    if (estimate > window * MID_TURN_RATIO) {
      const trimmed = trimToolResults(context, window * TRIM_RATIO, system);
      if (estimateTokens(system, trimmed, basis) <= window * MID_TURN_RATIO) return trimmed;

      await compactThread(deps, bot, threadId, turnStartId, signal);
      onCompacted(threadId);
      const updated = getThread(deps.db, threadId);
      context = contextFor(deps.db, threadId);
      basis =
        updated !== null && updated.lastInputTokens !== null && updated.lastInputMsgId !== null
          ? { inputTokens: updated.lastInputTokens, upToMsgId: updated.lastInputMsgId }
          : undefined;
      if (estimateTokens(system, context, basis) <= window * MID_TURN_RATIO) return context;
      return null;
    }

    return context;
  };
}
