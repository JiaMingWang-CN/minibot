import { promises as fs } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Provider } from '../config/types.ts';
import type { Bot } from '../config/types.ts';
import type { CallModel } from '../model/client.ts';
import { historyForModel } from '../model/adapter.ts';
import { AbortedError, ModelError } from '../model/types.ts';
import type { AssistantResult, Block, StoredMessage } from '../model/types.ts';
import { TOOL_SPECS, executeTool, type ToolEnv } from '../tools/registry.ts';
import { CANCELLED_TEXT, appendMessage } from '../db/messages.ts';
import { updateThread } from '../db/threads.ts';
import { buildTopicIndex } from '../memory/topics.ts';
import { buildSystemPrompt } from './prompt.ts';
import type { KernelEvent } from '../events.ts';

export const MAX_TOOL_ROUNDS = 50;

export interface TurnDeps {
  db: DatabaseSync;
  callModel: CallModel;
  emit: (e: KernelEvent) => void;
  resolveModel: (bot: Bot) => { provider: Provider; apiKey: string };
  makeToolEnv: (bot: Bot, threadId: string, signal: AbortSignal) => ToolEnv;
  prepareContext: (
    threadId: string,
    bot: Bot,
    signal: AbortSignal,
    turnStartId: number,
    system?: string,
  ) => Promise<StoredMessage[] | null>;
}

type ToolResultBlock = Extract<Block, { type: 'tool_result' }>;

function append(
  deps: TurnDeps,
  threadId: string,
  role: 'user' | 'assistant',
  blocks: Block[],
  kind: 'summary' | 'notice' | null = null,
  interrupted = false,
): StoredMessage {
  const message = appendMessage(deps.db, { threadId, role, blocks, kind, interrupted });
  deps.emit({ type: 'message', threadId, message });
  return message;
}

function notice(deps: TurnDeps, threadId: string, text: string): void {
  append(deps, threadId, 'user', [{ type: 'text', text }], 'notice');
}

function redactBlocks(blocks: Block[], secrets: { redact(text: string): string }): Block[] {
  return blocks.map((block) => {
    if (block.type === 'text') {
      return { type: 'text', text: secrets.redact(block.text) };
    }
    if (block.type === 'reasoning') {
      const copy: Block = { type: 'reasoning', text: secrets.redact(block.text) };
      if (block.opaque !== undefined) copy.opaque = block.opaque;
      return copy;
    }
    return structuredClone(block);
  });
}

function cancelledResults(toolUseIds: string[]): ToolResultBlock[] {
  return toolUseIds.map((toolUseId) => ({
    type: 'tool_result',
    toolUseId,
    content: CANCELLED_TEXT,
    status: 'cancelled',
  }));
}

function tools(blocks: Block[]): Extract<Block, { type: 'tool_use' }>[] {
  return blocks.filter(
    (b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use',
  );
}

export async function runTurn(
  deps: TurnDeps,
  bot: Bot,
  threadId: string,
  userText: string,
  signal: AbortSignal,
): Promise<void> {
  deps.emit({ type: 'turn', threadId, state: 'running' });
  const userMessage = append(deps, threadId, 'user', [{ type: 'text', text: userText }]);
  const turnStartId = userMessage.id;
  let envRef: ToolEnv | undefined;

  try {
    const env = deps.makeToolEnv(bot, threadId, signal);
    envRef = env;
    let userMd = '';
    try {
      userMd = await fs.readFile(env.paths.userMd, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const topics = await buildTopicIndex(env.paths.memoryDir(bot.id));
    const system = buildSystemPrompt({
      bot,
      workspace: env.workspace,
      userMd,
      userMdPath: env.paths.userMd,
      memoryDir: env.paths.memoryDir(bot.id),
      topics: topics.map((t) => ({ name: t.name, summary: t.summary })),
      platform: process.platform,
      now: new Date(),
    });

    const systemForEstimate = system + JSON.stringify(TOOL_SPECS);
    let toolRounds = 0;
    for (;;) {
      if (toolRounds >= MAX_TOOL_ROUNDS) {
        notice(deps, threadId, `工具调用轮数超过上限（${MAX_TOOL_ROUNDS}），已停止。`);
        return;
      }

      const context = await deps.prepareContext(threadId, bot, signal, turnStartId, systemForEstimate);
      if (context === null) {
        notice(deps, threadId, '上下文超出模型限制，无法继续本轮。');
        return;
      }
      const messages = historyForModel(context);
      const modelInfo = deps.resolveModel(bot);

      let result: AssistantResult;
      try {
        result = await deps.callModel({
          provider: modelInfo.provider,
          apiKey: modelInfo.apiKey,
          request: {
            model: bot.model,
            system,
            messages,
            tools: TOOL_SPECS,
            maxTokens: bot.maxOutputTokens,
            thinkingLevel: bot.thinkingLevel,
          },
          signal,
          onDelta: (d) => {
            deps.emit({
              type: 'delta',
              threadId,
              delta: { type: d.type, text: env.secrets.redact(d.text) },
            });
          },
        });
      } catch (err) {
        handleModelFailure(deps, threadId, env, err, signal);
        return;
      }

      updateThread(deps.db, threadId, { lastActivityAt: Date.now() });
      if (result.usage.inputTokens > 0) {
        const last = messages[messages.length - 1];
        updateThread(deps.db, threadId, {
          lastInputTokens: result.usage.inputTokens,
          lastInputMsgId: last?.id ?? turnStartId,
        });
      }

      let blocks = redactBlocks(result.blocks, env.secrets);
      if (result.stopReason === 'max_tokens') {
        blocks = blocks.filter((b) => b.type !== 'tool_use');
        if (blocks.length > 0) append(deps, threadId, 'assistant', blocks);
        notice(deps, threadId, '输出达到长度上限，已截断');
        return;
      }

      const toolUses = tools(blocks);
      append(deps, threadId, 'assistant', blocks);
      if (toolUses.length === 0) return;

      const results: ToolResultBlock[] = [];
      for (const call of toolUses) {
        if (signal.aborted) {
          results.push(...cancelledResults([call.id]));
          continue;
        }
        const output = await executeTool(call, env);
        results.push(output);
        updateThread(deps.db, threadId, { lastActivityAt: Date.now() });
      }
      append(deps, threadId, 'user', results);
      updateThread(deps.db, threadId, { lastActivityAt: Date.now() });

      if (signal.aborted) {
        notice(deps, threadId, '已中断');
        return;
      }
      toolRounds += 1;
    }
  } catch (err) {
    // 模型调用之外的失败（解析供应商、读取记忆、压缩等）：给用户一条提示，不静默结束
    if (signal.aborted) {
      notice(deps, threadId, '已中断');
    } else {
      const message = err instanceof Error ? err.message : String(err);
      notice(deps, threadId, `本轮失败：${envRef === undefined ? message : envRef.secrets.redact(message)}`);
    }
  } finally {
    deps.emit({ type: 'turn', threadId, state: 'idle' });
  }
}

function handleModelFailure(
  deps: TurnDeps,
  threadId: string,
  env: ToolEnv,
  err: unknown,
  signal: AbortSignal,
): void {
  const isAbort = err instanceof AbortedError || signal.aborted;
  const partial: Block[] | null =
    err instanceof AbortedError || err instanceof ModelError
      ? redactBlocks(err.partial, env.secrets)
      : null;

  if (isAbort) {
    if (partial !== null && partial.length > 0) {
      append(deps, threadId, 'assistant', partial, null, true);
      const ids = tools(partial).map((t) => t.id);
      if (ids.length > 0) append(deps, threadId, 'user', cancelledResults(ids));
    }
    notice(deps, threadId, '已中断');
    return;
  }

  if (err instanceof ModelError) {
    if (partial !== null && partial.length > 0) {
      append(deps, threadId, 'assistant', partial);
      const ids = tools(partial).map((t) => t.id);
      if (ids.length > 0) append(deps, threadId, 'user', cancelledResults(ids));
    }
    const limitFailure =
      err.kind === 'bad_request' && /max_tokens|max_output|maximum.*tokens/i.test(err.message);
    const text = limitFailure
      ? '输出上限超过模型允许值，请在 bot 设置里调小'
      : `模型调用失败：${err.kind} ${env.secrets.redact(err.message)}`;
    notice(deps, threadId, text);
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  notice(deps, threadId, `模型调用失败：${env.secrets.redact(message)}`);
}
