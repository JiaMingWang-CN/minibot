import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Kernel, KernelError } from '../src/kernel.ts';
import { ModelError } from '../src/model/types.ts';
import type { CallModel } from '../src/model/client.ts';
import type { KernelEvent } from '../src/events.ts';
import type { Block, StoredMessage } from '../src/model/types.ts';
import { fakeCrypto, waitFor } from './kernel-harness.ts';

async function open(model: CallModel): Promise<{ kernel: Kernel; threadId: string; events: KernelEvent[] }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-retry-'));
  const kernel = await Kernel.open({
    dataRoot: root,
    crypto: fakeCrypto(),
    callModel: model,
    retryDelaysMs: [1, 1, 1],
  });
  const events: KernelEvent[] = [];
  kernel.on((e) => events.push(e));
  const provider = await kernel.addProvider({
    name: 'P',
    format: 'chat_completions',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'sk-retry-secret-123',
  });
  const bot = await kernel.completeOnboarding({ providerId: provider.id, model: 'm' });
  return { kernel, threadId: kernel.createThread(bot.id).id, events };
}

function idleCount(events: KernelEvent[]): number {
  return events.filter((e) => e.type === 'turn' && e.state === 'idle').length;
}

function texts(messages: StoredMessage[]): string[] {
  return messages.map((m) =>
    m.blocks
      .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join(''),
  );
}

const ok = (text: string) => ({
  blocks: [{ type: 'text' as const, text }],
  stopReason: 'end' as const,
  usage: { inputTokens: 1, outputTokens: 1 },
});

test('自动重试：429 / 5xx / 网络错误且尚无输出时退避重试，成功后不留失败提示', async () => {
  const failures = [
    new ModelError('rate_limit', '429 too many'),
    new ModelError('server', '502 bad gateway'),
    new ModelError('network', 'ECONNRESET'),
  ];
  let calls = 0;
  const { kernel, threadId, events } = await open(async () => {
    calls += 1;
    const err = failures.shift();
    if (err !== undefined) throw err;
    return ok('好了');
  });
  kernel.sendMessage(threadId, '你好');
  await waitFor(() => idleCount(events) >= 1);
  assert.equal(calls, 4);
  assert.deepEqual(texts(kernel.listMessages(threadId)), ['你好', '好了']);
  const retries = events.filter((e) => e.type === 'retry');
  assert.deepEqual(
    retries.map((e) => (e as { attempt: number }).attempt),
    [1, 2, 3],
  );
  await kernel.close();
});

test('自动重试：次数用完后给出失败提示', async () => {
  let calls = 0;
  const { kernel, threadId, events } = await open(async () => {
    calls += 1;
    throw new ModelError('server', '503');
  });
  kernel.sendMessage(threadId, '你好');
  await waitFor(() => idleCount(events) >= 1);
  assert.equal(calls, 4);
  const last = kernel.listMessages(threadId).at(-1)!;
  assert.equal(last.kind, 'notice');
  assert.match(texts([last])[0]!, /模型调用失败/);
  await kernel.close();
});

test('自动重试：Key 错误、已有部分输出时不重试', async () => {
  let calls = 0;
  const { kernel, threadId, events } = await open(async () => {
    calls += 1;
    throw new ModelError('auth', '401');
  });
  kernel.sendMessage(threadId, '你好');
  await waitFor(() => idleCount(events) >= 1);
  assert.equal(calls, 1);
  await kernel.close();

  let calls2 = 0;
  const second = await open(async () => {
    calls2 += 1;
    throw new ModelError('stream', 'connection reset', { partial: [{ type: 'text', text: '一半' }] });
  });
  second.kernel.sendMessage(second.threadId, '你好');
  await waitFor(() => idleCount(second.events) >= 1);
  assert.equal(calls2, 1);
  await second.kernel.close();
});

test('手动重试：删除最后一轮的回复与提示，用原用户消息重跑，发出 messages_deleted', async () => {
  let fail = true;
  const { kernel, threadId, events } = await open(async () => {
    if (fail) throw new ModelError('auth', '401');
    return ok('重试成功');
  });
  kernel.sendMessage(threadId, '第一句');
  await waitFor(() => idleCount(events) >= 1);
  const before = kernel.listMessages(threadId);
  assert.equal(before.length, 2);
  const userId = before[0]!.id;
  fail = false;
  kernel.retry(threadId);
  await waitFor(() => idleCount(events) >= 2);
  const after = kernel.listMessages(threadId);
  assert.deepEqual(texts(after), ['第一句', '重试成功']);
  assert.equal(after[0]!.id, userId);
  const deleted = events.find((e) => e.type === 'messages_deleted') as
    | { threadId: string; fromId: number }
    | undefined;
  assert.deepEqual(deleted, { type: 'messages_deleted', threadId, fromId: userId + 1 });
  await kernel.close();
});

test('手动重试：线程运行中 → conflict；没有用户消息 → invalid；线程不存在 → not_found', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { kernel, threadId, events } = await open(async () => {
    await gate;
    return ok('完');
  });
  assert.throws(() => kernel.retry(threadId), (e) => e instanceof KernelError && e.code === 'invalid');
  assert.throws(() => kernel.retry('nope'), (e) => e instanceof KernelError && e.code === 'not_found');
  kernel.sendMessage(threadId, '慢慢来');
  await waitFor(() => events.some((e) => e.type === 'turn' && e.state === 'running'));
  assert.throws(() => kernel.retry(threadId), (e) => e instanceof KernelError && e.code === 'conflict');
  release();
  await waitFor(() => idleCount(events) >= 1);
  await kernel.close();
});
