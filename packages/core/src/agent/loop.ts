import { promises as fs } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Provider } from '../config/types.ts';
import type { Bot } from '../config/types.ts';
import type { CallModel } from '../model/client.ts';
import { historyForModel, imagesOf } from '../model/adapter.ts';
import { AbortedError, ModelError } from '../model/types.ts';
import type { AssistantResult, Block, StoredMessage, Usage } from '../model/types.ts';
import { TOOL_SPECS, executeTool, type ToolEnv } from '../tools/registry.ts';
import type { TurnToolset } from '../tools/catalog.ts';
import { CANCELLED_TEXT, appendMessage } from '../db/messages.ts';
import { updateThread } from '../db/threads.ts';
import { buildTopicIndex } from '../memory/topics.ts';
import { buildSystemPrompt } from './prompt.ts';
import type { KernelEvent } from '../events.ts';

export const MAX_TOOL_ROUNDS = 50;
/** 自动重试的等待时间（毫秒），长度即最多重试次数 */
export const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000];

export interface TurnDeps {
  db: DatabaseSync;
  callModel: CallModel;
  emit: (e: KernelEvent) => void;
  resolveModel: (bot: Bot) => { provider: Provider; apiKey: string };
  makeToolEnv: (bot: Bot, threadId: string, signal: AbortSignal) => ToolEnv;
  /** 每轮开头取一次工具快照，本轮所有模型调用与工具执行都用它；不给时只用内置工具 */
  snapshotTools?: (bot: Bot) => Promise<TurnToolset>;
  prepareContext: (
    threadId: string,
    bot: Bot,
    signal: AbortSignal,
    turnStartId: number,
    system?: string,
  ) => Promise<StoredMessage[] | null>;
  retryDelaysMs?: number[];
  /** 取走本线程运行中收到的插话（每项是一条用户消息的内容块） */
  takeSteer?: (threadId: string) => Block[][];
  /** 读取图片附件，返回 id → base64；读不到的 id 不出现在结果里 */
  loadAttachments?: (ids: string[]) => Promise<Record<string, string>>;
}

/** 本轮的输入：新的用户消息文字、新的用户消息内容块，或从已有的用户消息重跑（手动重试） */
export type TurnInput = string | { blocks: Block[] } | { resumeFromId: number };

type ToolResultBlock = Extract<Block, { type: 'tool_result' }>;

function append(
  deps: TurnDeps,
  threadId: string,
  role: 'user' | 'assistant',
  blocks: Block[],
  kind: 'summary' | 'notice' | null = null,
  interrupted = false,
  usage?: Usage,
): StoredMessage {
  const message = appendMessage(deps.db, {
    threadId,
    role,
    blocks,
    kind,
    interrupted,
    ...(usage !== undefined ? { usage } : {}),
  });
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

/** 还没产生任何输出、且属于限流 / 服务端 / 网络 / 流中断的失败才自动重试 */
function isRetryable(err: unknown): err is ModelError {
  return (
    err instanceof ModelError &&
    err.partial.length === 0 &&
    (err.kind === 'rate_limit' || err.kind === 'server' || err.kind === 'network' || err.kind === 'stream')
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runTurn(
  deps: TurnDeps,
  bot: Bot,
  threadId: string,
  input: TurnInput,
  signal: AbortSignal,
): Promise<void> {
  deps.emit({ type: 'turn', threadId, state: 'running' });
  let turnStartId: number;
  if (typeof input === 'object' && 'resumeFromId' in input) {
    turnStartId = input.resumeFromId;
  } else {
    const blocks: Block[] = typeof input === 'string' ? [{ type: 'text', text: input }] : input.blocks;
    turnStartId = append(deps, threadId, 'user', blocks).id;
  }
  let envRef: ToolEnv | undefined;

  // 把运行中收到的插话作为用户消息接在当前位置；返回是否插入了内容
  const injectSteer = (): boolean => {
    const items = deps.takeSteer?.(threadId) ?? [];
    for (const blocks of items) append(deps, threadId, 'user', blocks);
    return items.length > 0;
  };

  try {
    const env = deps.makeToolEnv(bot, threadId, signal);
    envRef = env;
    // 本轮工具快照：开头取一次，本轮不再重新取；用户中途开关扩展下一轮才生效
    const toolset: TurnToolset =
      deps.snapshotTools === undefined
        ? { specs: TOOL_SPECS, external: () => undefined, skills: [] }
        : await deps.snapshotTools(bot);
    env.toolset = toolset;
    let userMd = '';
    try {
      userMd = await fs.readFile(env.paths.userMd, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const topics = bot.memoryEnabled ? await buildTopicIndex(env.paths.memoryDir(bot.id)) : [];
    const system = buildSystemPrompt({
      bot,
      workspace: env.workspace,
      userMd,
      userMdPath: env.paths.userMd,
      memoryDir: env.paths.memoryDir(bot.id),
      topics: topics.map((t) => ({ name: t.name, summary: t.summary })),
      skills: toolset.skills.map((s) => ({ name: s.name, description: s.description })),
      platform: process.platform,
      now: new Date(),
    });

    const systemForEstimate = system + JSON.stringify(toolset.specs);
    const retryDelays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
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
      const imageIds = messages.flatMap((m) => imagesOf(m.blocks).map((b) => b.id));
      const attachments =
        imageIds.length > 0 && deps.loadAttachments !== undefined ? await deps.loadAttachments(imageIds) : undefined;
      const modelInfo = deps.resolveModel(bot);

      let result: AssistantResult | undefined;
      for (let attempt = 0; result === undefined; ) {
        // Key 可能被切在两个增量之间：流式阶段按流缓冲脱敏，调用结束（成功或失败）时放出剩余
        const stream = env.secrets.streamRedactor();
        const emitDelta = (type: 'text' | 'reasoning', text: string): void => {
          if (text.length > 0) deps.emit({ type: 'delta', threadId, delta: { type, text } });
        };
        const flushStream = (): void => {
          emitDelta('text', stream.flush('text'));
          emitDelta('reasoning', stream.flush('reasoning'));
        };
        try {
          result = await deps.callModel({
            provider: modelInfo.provider,
            apiKey: modelInfo.apiKey,
            request: {
              model: bot.model,
              system,
              messages,
              tools: toolset.specs,
              maxTokens: bot.maxOutputTokens,
              thinkingLevel: bot.thinkingLevel,
              ...(attachments !== undefined ? { attachments } : {}),
            },
            signal,
            onDelta: (d) => emitDelta(d.type, stream.push(d.type, d.text)),
          });
          flushStream();
        } catch (err) {
          flushStream();
          const delayMs = retryDelays[attempt];
          if (delayMs !== undefined && isRetryable(err) && !signal.aborted) {
            attempt += 1;
            deps.emit({
              type: 'retry',
              threadId,
              attempt,
              delayMs,
              message: env.secrets.redact(err.message),
            });
            if (await sleep(delayMs, signal)) continue;
          }
          handleModelFailure(deps, threadId, env, err, signal, imageIds.length > 0);
          return;
        }
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
        if (blocks.length > 0) append(deps, threadId, 'assistant', blocks, null, false, result.usage);
        notice(deps, threadId, '输出达到长度上限，已截断');
        return;
      }

      const toolUses = tools(blocks);
      append(deps, threadId, 'assistant', blocks, null, false, result.usage);
      if (toolUses.length === 0) {
        // 模型本来要结束，但期间用户又发了消息：接着在本轮里回应
        if (!signal.aborted && injectSteer()) continue;
        return;
      }

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
      injectSteer();
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
  hadImages: boolean,
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
    let text = limitFailure
      ? '输出上限超过模型允许值，请在 bot 设置里调小'
      : `模型调用失败：${err.kind} ${env.secrets.redact(err.message)}`;
    if (!limitFailure && err.kind === 'bad_request' && hadImages) {
      text += '\n（这次请求带了图片，所用模型可能不支持图片输入）';
    }
    notice(deps, threadId, text);
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  notice(deps, threadId, `模型调用失败：${env.secrets.redact(message)}`);
}
