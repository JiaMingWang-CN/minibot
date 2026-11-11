import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletionsAdapter } from '../src/model/chat-completions.ts';
import { responsesAdapter } from '../src/model/responses.ts';
import { anthropicAdapter } from '../src/model/anthropic.ts';
import { parseSse } from '../src/model/sse.ts';
import { ResultAccumulator } from '../src/model/accumulator.ts';
import type { Adapter } from '../src/model/adapter.ts';
import type { AssistantResult } from '../src/model/types.ts';
import { kernelHarness, waitIdle } from './kernel-harness.ts';
import type { CallModel } from '../src/model/client.ts';

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const text = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

async function parse(adapter: Adapter, events: unknown[]): Promise<AssistantResult> {
  const acc = new ResultAccumulator(() => {});
  await adapter.parse(parseSse(sse(events)), acc, 'm');
  return acc.result();
}

test('用量：Chat Completions 读 prompt_tokens_details.cached_tokens', async () => {
  const r = await parse(chatCompletionsAdapter, [
    { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } } },
    '[DONE]',
  ]);
  assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 7, cachedInputTokens: 60 });
});

test('用量：Chat Completions 读 DeepSeek 的 prompt_cache_hit_tokens', async () => {
  const r = await parse(chatCompletionsAdapter, [
    { choices: [], usage: { prompt_tokens: 50, completion_tokens: 3, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 10 } },
    '[DONE]',
  ]);
  assert.deepEqual(r.usage, { inputTokens: 50, outputTokens: 3, cachedInputTokens: 40 });
});

test('用量：供应商没报缓存时不填 cachedInputTokens（不当作 0）', async () => {
  const r = await parse(chatCompletionsAdapter, [
    { choices: [], usage: { prompt_tokens: 50, completion_tokens: 3 } },
    '[DONE]',
  ]);
  assert.deepEqual(r.usage, { inputTokens: 50, outputTokens: 3 });
});

test('用量：Responses 读 input_tokens_details.cached_tokens', async () => {
  const r = await parse(responsesAdapter, [
    {
      type: 'response.completed',
      response: { usage: { input_tokens: 80, output_tokens: 9, input_tokens_details: { cached_tokens: 64 } } },
    },
  ]);
  assert.deepEqual(r.usage, { inputTokens: 80, outputTokens: 9, cachedInputTokens: 64 });
});

test('用量：Anthropic 输入 = input + cache_read + cache_creation，缓存命中 = cache_read', async () => {
  const r = await parse(anthropicAdapter, [
    {
      type: 'message_start',
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 70, cache_creation_input_tokens: 20, output_tokens: 1 } },
    },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } },
  ]);
  assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 12, cachedInputTokens: 70 });
});

test('用量：每次模型调用的用量记在 assistant 消息上，threadUsage 汇总；有一次没报缓存则缓存合计为 null', async () => {
  let n = 0;
  const model: CallModel = async () => {
    n += 1;
    return {
      blocks: [{ type: 'text', text: `第${n}次` }],
      stopReason: 'end',
      usage: n === 1 ? { inputTokens: 100, outputTokens: 10, cachedInputTokens: 30 } : { inputTokens: 200, outputTokens: 20, cachedInputTokens: 150 },
    };
  };
  const h = await kernelHarness(model);
  h.kernel.sendMessage(h.threadId, '一');
  await waitIdle(h, 1);
  h.kernel.sendMessage(h.threadId, '二');
  await waitIdle(h, 2);
  const assistants = h.kernel.listMessages(h.threadId).filter((m) => m.role === 'assistant');
  assert.deepEqual(assistants[0]!.usage, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 30 });
  assert.deepEqual(h.kernel.threadUsage(h.threadId), {
    calls: 2,
    inputTokens: 300,
    outputTokens: 30,
    cachedInputTokens: 180,
  });
  await h.close();

  const h2 = await kernelHarness(async () => ({
    blocks: [{ type: 'text', text: 'x' }],
    stopReason: 'end',
    usage: { inputTokens: 5, outputTokens: 1 },
  }));
  h2.kernel.sendMessage(h2.threadId, '一');
  await waitIdle(h2, 1);
  assert.deepEqual(h2.kernel.threadUsage(h2.threadId), {
    calls: 1,
    inputTokens: 5,
    outputTokens: 1,
    cachedInputTokens: null,
  });
  // 用户消息不带 usage 字段
  assert.equal('usage' in h2.kernel.listMessages(h2.threadId)[0]!, false);
  await h2.close();
});
