import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KernelError } from '../src/kernel.ts';
import type { CallModel } from '../src/model/client.ts';
import { kernelHarness, textModel, waitFor, waitIdle } from './kernel-harness.ts';
import { appendMessage } from '../src/db/messages.ts';

test('线程改名：去掉首尾空白；空名或超过 100 字 → invalid；不存在 → not_found', async () => {
  const h = await kernelHarness();
  const renamed = h.kernel.renameThread(h.threadId, '  周报整理  ');
  assert.equal(renamed.title, '周报整理');
  assert.equal(h.kernel.listThreads(h.bot.id)[0]!.title, '周报整理');
  assert.throws(() => h.kernel.renameThread(h.threadId, '   '), (e) => e instanceof KernelError && e.code === 'invalid');
  assert.throws(
    () => h.kernel.renameThread(h.threadId, '长'.repeat(101)),
    (e) => e instanceof KernelError && e.code === 'invalid',
  );
  assert.throws(() => h.kernel.renameThread('nope', 'x'), (e) => e instanceof KernelError && e.code === 'not_found');
  await h.close();
});

test('删除线程：消息与线程一起删除，发出 thread_deleted；搜索不再命中', async () => {
  const h = await kernelHarness(textModel('关于咖啡豆的回答'));
  h.kernel.sendMessage(h.threadId, '推荐咖啡豆');
  await waitIdle(h);
  assert.equal(h.kernel.search('咖啡豆').length, 2);
  await h.kernel.deleteThread(h.threadId);
  assert.deepEqual(h.kernel.listThreads(h.bot.id), []);
  assert.deepEqual(h.kernel.listMessages(h.threadId), []);
  assert.deepEqual(h.kernel.search('咖啡豆'), []);
  assert.ok(h.events.some((e) => e.type === 'thread_deleted' && e.threadId === h.threadId));
  await assert.rejects(h.kernel.deleteThread(h.threadId), (e) => e instanceof KernelError && e.code === 'not_found');
  await h.close();
});

test('删除线程：正在运行时先中止（含待审批），等本轮结束后再删', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model: CallModel = async ({ signal }) => {
    // 与 fetch 一致：signal 已中止时立即失败
    if (signal.aborted) throw new Error('aborted');
    await Promise.race([
      gate,
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    ]);
    return { blocks: [{ type: 'text', text: 'x' }], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const h = await kernelHarness(model);
  h.kernel.sendMessage(h.threadId, '慢');
  await waitFor(() => h.events.some((e) => e.type === 'turn' && e.state === 'running'));
  await h.kernel.deleteThread(h.threadId);
  release();
  assert.deepEqual(h.kernel.listThreads(h.bot.id), []);
  assert.deepEqual(h.kernel.listMessages(h.threadId), []);
  await h.close();
});

test('搜索：中文子串（含两个字的词）命中用户与助手消息，带线程标题与片段；空查询 → invalid', async () => {
  const h = await kernelHarness(textModel('明天上午十点开周会，记得带上季度报表。'));
  h.kernel.renameThread(h.threadId, '日程');
  h.kernel.sendMessage(h.threadId, '帮我记一下周会的时间');
  await waitIdle(h);
  const hits = h.kernel.search('周会');
  assert.equal(hits.length, 2);
  const assistantHit = hits.find((x) => x.role === 'assistant')!;
  assert.equal(assistantHit.threadId, h.threadId);
  assert.equal(assistantHit.threadTitle, '日程');
  assert.equal(assistantHit.botId, h.bot.id);
  assert.match(assistantHit.snippet, /周会/);
  assert.equal(h.kernel.search('季度报表').length, 1);
  assert.equal(h.kernel.search('不存在的内容').length, 0);
  assert.equal(h.kernel.search('周会', { botId: 'other' }).length, 0);
  assert.throws(() => h.kernel.search('  '), (e) => e instanceof KernelError && e.code === 'invalid');
  await h.close();
});

test('搜索：通知类消息不进索引；特殊字符按字面匹配', async () => {
  const h = await kernelHarness(textModel('用 a"b*c 作为分隔符'));
  h.kernel.sendMessage(h.threadId, '分隔符是什么');
  await waitIdle(h);
  assert.equal(h.kernel.search('a"b*c').length, 1);
  assert.equal(h.kernel.search('已中断').length, 0);
  await h.close();
});

test('listMessages：limit 取整并夹到 1–200，before 非整数报 invalid', async () => {
  const h = await kernelHarness();
  try {
    for (let i = 0; i < 3; i++) {
      appendMessage(h.kernel['db'], { threadId: h.threadId, role: 'user', blocks: [{ type: 'text', text: String(i) }], kind: null, interrupted: false });
    }
    assert.equal(h.kernel.listMessages(h.threadId, undefined, -1).length, 1);
    assert.equal(h.kernel.listMessages(h.threadId, undefined, 0).length, 1);
    assert.equal(h.kernel.listMessages(h.threadId, undefined, 2.7).length, 2);
    assert.equal(h.kernel.listMessages(h.threadId, undefined, 1000).length, 3);
    assert.equal(h.kernel.listMessages(h.threadId, undefined, Number.NaN).length, 3);
    assert.throws(() => h.kernel.listMessages(h.threadId, 1.5), (e: unknown) => e instanceof KernelError && e.code === 'invalid');
    assert.throws(() => h.kernel.listMessages(h.threadId, Number.NaN), (e: unknown) => e instanceof KernelError && e.code === 'invalid');
  } finally {
    await h.close();
  }
});
