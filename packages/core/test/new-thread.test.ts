import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kernelHarness, waitIdle } from './kernel-harness.ts';

test('新建对话：已有空对话时复用，不会无限新建', async () => {
  const h = await kernelHarness();
  const again = h.kernel.createThread(h.bot.id);
  assert.equal(again.id, h.threadId);
  assert.equal(h.kernel.listThreads(h.bot.id).length, 1);
  await h.close();
});

test('新建对话：现有对话有消息后才能新建下一个', async () => {
  const h = await kernelHarness();
  h.kernel.sendMessage(h.threadId, '在吗');
  await waitIdle(h);
  const next = h.kernel.createThread(h.bot.id);
  assert.notEqual(next.id, h.threadId);
  assert.equal(h.kernel.createThread(h.bot.id).id, next.id);
  assert.equal(h.kernel.listThreads(h.bot.id).length, 2);
  await h.close();
});
