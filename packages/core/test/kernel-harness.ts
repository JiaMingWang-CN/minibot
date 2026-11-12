import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Kernel } from '../src/kernel.ts';
import type { OpenOptions } from '../src/kernel.ts';
import type { KernelEvent } from '../src/events.ts';
import type { KeyCrypto } from '../src/secrets/store.ts';
import type { CallModel } from '../src/model/client.ts';
import type { Bot } from '../src/config/types.ts';

// 多个测试文件共用的内核夹具：一个供应商、一个主 bot、一个线程。

export function fakeCrypto(): KeyCrypto {
  return {
    backend: () => 'os',
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decrypt: (buf) => Buffer.from(buf.toString('utf8').slice(4), 'base64').toString('utf8'),
  };
}

export function textModel(text = '收到'): CallModel {
  return async ({ onDelta }) => {
    onDelta({ type: 'text', text });
    return {
      blocks: [{ type: 'text', text }],
      stopReason: 'end',
      usage: { inputTokens: 5, outputTokens: 1 },
    };
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export interface KernelHarness {
  root: string;
  kernel: Kernel;
  bot: Bot;
  threadId: string;
  events: KernelEvent[];
  close(): Promise<void>;
}

export async function kernelHarness(
  model: CallModel = textModel(),
  options: Partial<Omit<OpenOptions, 'dataRoot' | 'callModel'>> = {},
): Promise<KernelHarness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-h-'));
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: model, ...options });
  const events: KernelEvent[] = [];
  kernel.on((e) => events.push(e));
  const provider = await kernel.addProvider({
    name: 'P',
    format: 'chat_completions',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'sk-harness-secret-123',
  });
  const bot = await kernel.completeOnboarding({ providerId: provider.id, model: 'm' });
  const thread = kernel.createThread(bot.id);
  return {
    root,
    kernel,
    bot,
    threadId: thread.id,
    events,
    close: () => kernel.close(),
  };
}

/** 等某线程本轮结束（收到 turn idle 事件的次数达到 n） */
export async function waitIdle(h: KernelHarness, n = 1, threadId = h.threadId): Promise<void> {
  await waitFor(
    () =>
      h.events.filter((e) => e.type === 'turn' && e.threadId === threadId && e.state === 'idle').length >= n,
  );
}
