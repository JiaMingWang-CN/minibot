import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths } from '../src/paths.ts';
import { openDb } from '../src/db/db.ts';
import { createThread } from '../src/db/threads.ts';
import { getThread, updateThread } from '../src/db/threads.ts';
import { messagesFrom, getMessage, appendMessage } from '../src/db/messages.ts';
import { newBot } from '../src/config/config.ts';
import type { Bot } from '../src/config/types.ts';
import {
  estimateChars,
  estimateTokens,
  contextFor,
  trimToolResults,
  compactThread,
  makePrepareContext,
  TRIM_PLACEHOLDER,
  SUMMARY_PREFIX,
} from '../src/agent/compaction.ts';
import type { Block, StoredMessage } from '../src/model/types.ts';
import type { KernelEvent } from '../src/events.ts';
import type { ModelRequest } from '../src/model/adapter.ts';

async function setup(contextWindow = 1000): Promise<{
  root: string;
  paths: ReturnType<typeof dataPaths>;
  db: ReturnType<typeof openDb>;
  bot: Bot;
  threadId: string;
  deps: Parameters<typeof compactThread>[0];
  calls: ModelRequest[];
  events: KernelEvent[];
  add(role: 'user' | 'assistant', blocks: Block[]): StoredMessage;
  close(): void;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-compact-'));
  const paths = dataPaths(root);
  const db = openDb(paths.db);
  const bot = newBot('b1', 'p1', 'm');
  bot.contextWindow = contextWindow;
  const thread = createThread(db, 'b1', 't');
  const calls: ModelRequest[] = [];
  const events: KernelEvent[] = [];
  const deps = {
    db,
    callModel: async (a: Parameters<Parameters<typeof makePrepareContext>[0]['callModel']>[0]) => {
      calls.push(a.request);
      return {
        blocks: [{ type: 'text' as const, text: '摘要内容' }],
        stopReason: 'end' as const,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    resolveModel: () => ({
      provider: { id: 'p1', name: 'p', format: 'chat_completions' as const, baseUrl: 'http://x' },
      apiKey: 'sk-test-secret-123',
    }),
    emit: (e: KernelEvent) => events.push(e),
  };
  const add = (role: 'user' | 'assistant', blocks: Block[]): StoredMessage =>
    appendMessage(db, { threadId: thread.id, role, blocks, kind: null, interrupted: false });
  return {
    root,
    paths,
    db,
    bot,
    threadId: thread.id,
    deps,
    calls,
    events,
    add,
    close: () => db.close(),
  };
}

function text(value: string): Block {
  return { type: 'text', text: value };
}

test('估算：纯中文 1000 字 → 1200；纯英文 3500 字符 → 1000', () => {
  assert.equal(estimateChars('中'.repeat(1000)), 1200);
  assert.equal(estimateChars('a'.repeat(3500)), 1000);
});

test('估算：有 baseline 时只估增量；baseline 的消息已被压缩掉时回退为全量估算', () => {
  const messages: StoredMessage[] = [
    { id: 1, threadId: 't', role: 'user', blocks: [text('a')], kind: null, interrupted: false, createdAt: 0 },
    { id: 2, threadId: 't', role: 'assistant', blocks: [text('b')], kind: null, interrupted: false, createdAt: 0 },
    { id: 3, threadId: 't', role: 'user', blocks: [text('c')], kind: null, interrupted: false, createdAt: 0 },
  ];
  const incremental = estimateTokens('', messages, { inputTokens: 100, upToMsgId: 2 });
  assert.equal(incremental, 100 + estimateChars(JSON.stringify([messages[2]])));
  const full = estimateTokens('SYS', messages, { inputTokens: 100, upToMsgId: 99 });
  assert.equal(full, estimateChars(`SYS${JSON.stringify(messages)}`));
});

test('一轮开始时估算值 > 0.8×窗口 → 完整压缩，之后请求 = 摘要 + 保留的部分', async () => {
  const h = await setup(1000);
  h.add('user', [text('x'.repeat(3000))]);
  h.add('assistant', [text('y'.repeat(3000))]);
  const turnStart = h.add('user', [text('继续')]);
  const compacted: string[] = [];
  const prepare = makePrepareContext(h.deps, (id) => compacted.push(id));
  const context = await prepare(h.threadId, h.bot, new AbortController().signal, turnStart.id);
  assert.ok(context !== null);
  assert.equal(context![0]!.kind, 'summary');
  assert.ok(
    (context![0]!.blocks[0] as Extract<Block, { type: 'text' }>).text.startsWith(SUMMARY_PREFIX),
  );
  assert.equal(context![context!.length - 1]!.id, turnStart.id);
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0], h.threadId);
  const thread = getThread(h.db, h.threadId)!;
  assert.equal(thread.summaryMsgId, context![0]!.id);
  assert.equal(thread.keepFromMsgId, turnStart.id);
  h.close();
});

test('保留边界落在纯文本 user 消息上，不把 tool_use 和 tool_result 拆开', async () => {
  const h = await setup(1000);
  h.add('user', [text('第一轮')]);
  h.add('assistant', [text('a'.repeat(1000))]);
  h.add('user', [
    { type: 'tool_result', toolUseId: 'tu_1', content: 'x'.repeat(2000), status: 'ok' },
  ]);
  h.add('assistant', [text('b'.repeat(1500))]);
  const second = h.add('user', [text('第三轮')]);
  await compactThread(h.deps, h.bot, h.threadId, 'auto', new AbortController().signal);
  const thread = getThread(h.db, h.threadId)!;
  const boundary = getMessage(h.db, thread.keepFromMsgId)!;
  assert.equal(boundary.role, 'user');
  assert.ok(boundary.blocks.every((b) => b.type === 'text'));
  assert.equal(boundary.id, second.id);
  const summary = messagesFrom(h.db, h.threadId, 0).find((m) => m.kind === 'summary');
  assert.ok(summary !== undefined);
  h.close();
});

test('轮内估算值 > 0.9×窗口 → 先裁剪旧工具输出到 ≤ 0.7×窗口；库里原文不变', async () => {
  const h = await setup(1000);
  h.add('user', [text('a'.repeat(1000))]);
  h.add('assistant', [
    { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'big.txt' } },
  ]);
  const resultMessage = h.add('user', [
    { type: 'tool_result', toolUseId: 'tu_1', content: 'z'.repeat(5000), status: 'ok' },
  ]);
  const prepare = makePrepareContext(h.deps, () => {});
  const context = await prepare(h.threadId, h.bot, new AbortController().signal, 999);
  assert.ok(context !== null);
  const toolResult = context!
    .flatMap((m) => m.blocks)
    .find((b) => b.type === 'tool_result') as Extract<Block, { type: 'tool_result' }>;
  assert.equal(toolResult.content, TRIM_PLACEHOLDER);
  const stored = getMessage(h.db, resultMessage.id)!;
  const storedBlock = stored.blocks[0] as Extract<Block, { type: 'tool_result' }>;
  assert.equal(storedBlock.content, 'z'.repeat(5000));
  assert.equal(h.calls.length, 0);
  h.close();
});

test('裁剪后仍 > 0.9×窗口 → 对本轮开始之前的消息做中途摘要', async () => {
  const h = await setup(1000);
  h.add('user', [text('x'.repeat(5000))]);
  h.add('assistant', [text('ok')]);
  const turnStart = h.add('user', [text('继续')]);
  h.add('assistant', [
    { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } },
  ]);
  const compacted: string[] = [];
  const prepare = makePrepareContext(h.deps, (id) => compacted.push(id));
  const context = await prepare(h.threadId, h.bot, new AbortController().signal, turnStart.id);
  assert.ok(context !== null);
  assert.equal(context![0]!.kind, 'summary');
  assert.equal(compacted.length, 1);
  const keptIds = context!.slice(1).map((m) => m.id);
  assert.deepEqual(keptIds, [turnStart.id, turnStart.id + 1]);
  h.close();
});

test('带基线时，裁剪结果按内容估算：裁掉基线之前的内容有效，不触发摘要', async () => {
  const h = await setup(1000);
  h.add('user', [text('go')]);
  h.add('assistant', [{ type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'big.txt' } }]);
  const big = h.add('user', [
    { type: 'tool_result', toolUseId: 'tu_1', content: 'z'.repeat(5000), status: 'ok' },
  ]);
  h.add('assistant', [text('好')]);
  updateThread(h.db, h.threadId, { lastInputTokens: 950, lastInputMsgId: big.id });
  const prepare = makePrepareContext(h.deps, () => {});
  const context = await prepare(h.threadId, h.bot, new AbortController().signal, 999);
  assert.ok(context !== null);
  assert.ok(context!.every((m) => m.kind !== 'summary'));
  assert.equal(h.calls.length, 0);
  h.close();
});

test('压缩本轮之前的历史后仍超限 → 再裁剪本轮的工具输出，而不是直接返回 null', async () => {
  const h = await setup(1000);
  h.add('user', [text('x'.repeat(5000))]);
  h.add('assistant', [text('ok')]);
  const turnStart = h.add('user', [text('继续')]);
  h.add('assistant', [{ type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } }]);
  h.add('user', [{ type: 'tool_result', toolUseId: 'tu_1', content: 'z'.repeat(3500), status: 'ok' }]);
  const prepare = makePrepareContext(h.deps, () => {});
  const context = await prepare(h.threadId, h.bot, new AbortController().signal, turnStart.id);
  assert.ok(context !== null);
  assert.equal(context![0]!.kind, 'summary');
  const result = context!
    .flatMap((m) => m.blocks)
    .find((b) => b.type === 'tool_result') as Extract<Block, { type: 'tool_result' }>;
  assert.equal(result.content, TRIM_PLACEHOLDER);
  h.close();
});

test('仍放不下 → 返回 null', async () => {
  const h = await setup(1000);
  h.add('user', [text('x'.repeat(5000))]);
  h.add('assistant', [text('y'.repeat(5000))]);
  const turnStart = h.add('user', [text('z'.repeat(5000))]);
  const prepare = makePrepareContext(h.deps, () => {});
  const context = await prepare(h.threadId, h.bot, new AbortController().signal, turnStart.id);
  assert.equal(context, null);
  assert.equal(h.calls.length, 2);
  h.close();
});

test('手动压缩：线程空闲时 compactThread(..., "auto") 可用', async () => {
  const h = await setup(1000);
  h.add('user', [text('第一轮')]);
  h.add('assistant', [text('a'.repeat(2000))]);
  h.add('user', [text('第二轮')]);
  await compactThread(h.deps, h.bot, h.threadId, 'auto', new AbortController().signal);
  const thread = getThread(h.db, h.threadId)!;
  const summary = getMessage(h.db, thread.summaryMsgId!)!;
  assert.equal(summary.kind, 'summary');
  assert.ok(
    (summary.blocks[0] as Extract<Block, { type: 'text' }>).text.startsWith(SUMMARY_PREFIX),
  );
  assert.ok(contextFor(h.db, h.threadId).length >= 2);
  h.close();
});

test('压缩后作废 token 基线，估算按压缩后的内容重算', async () => {
  const h = await setup(1000);
  h.add('user', [text('第一轮')]);
  h.add('assistant', [text('a'.repeat(2000))]);
  const last = h.add('user', [text('第二轮')]);
  updateThread(h.db, h.threadId, { lastInputTokens: 900, lastInputMsgId: last.id });
  await compactThread(h.deps, h.bot, h.threadId, 'auto', new AbortController().signal);
  const thread = getThread(h.db, h.threadId)!;
  assert.equal(thread.lastInputTokens, null);
  assert.equal(thread.lastInputMsgId, null);
  h.close();
});

test('trimToolResults 不改库，返回副本', async () => {
  const h = await setup(1000);
  const resultMessage = h.add('user', [
    { type: 'tool_result', toolUseId: 'tu_1', content: 'q'.repeat(5000), status: 'ok' },
  ]);
  const trimmed = trimToolResults(messagesFrom(h.db, h.threadId, 0), 500, '');
  const block = trimmed[0]!.blocks[0] as Extract<Block, { type: 'tool_result' }>;
  assert.equal(block.content, TRIM_PLACEHOLDER);
  const stored = getMessage(h.db, resultMessage.id)!;
  assert.equal((stored.blocks[0] as Extract<Block, { type: 'tool_result' }>).content, 'q'.repeat(5000));
  h.close();
});
