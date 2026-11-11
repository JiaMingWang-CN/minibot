import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallModel } from '../src/model/client.ts';
import type { ModelRequest } from '../src/model/adapter.ts';
import type { Block, StoredMessage } from '../src/model/types.ts';
import { buildSystemPrompt } from '../src/agent/prompt.ts';
import { newBot, saveBot, loadBot } from '../src/config/config.ts';
import { dataPaths } from '../src/paths.ts';
import { openDb } from '../src/db/db.ts';
import { createThread, updateThread } from '../src/db/threads.ts';
import { appendMessage } from '../src/db/messages.ts';
import { MemoryRevisions } from '../src/memory/revisions.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import { Consolidator, IDLE_MS } from '../src/memory/consolidate.ts';
import { kernelHarness, waitFor, waitIdle } from './kernel-harness.ts';

function texts(messages: StoredMessage[]): string[] {
  return messages.map((m) =>
    m.blocks
      .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join(''),
  );
}

function lastUserText(req: ModelRequest): string {
  const users = req.messages.filter((m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text'));
  return texts(users.slice(-1))[0] ?? '';
}

test('插话：运行中发的消息在工具结果之后插入本轮，不另起一轮', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: ModelRequest[] = [];
  const model: CallModel = async ({ request }) => {
    calls.push(structuredClone(request));
    if (calls.length === 1) {
      await gate;
      return {
        blocks: [{ type: 'tool_use', id: 'tu_1', name: 'glob', input: { pattern: '*' } }],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    return { blocks: [{ type: 'text', text: '已按新要求处理' }], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const h = await kernelHarness(model);
  assert.equal(h.kernel.sendMessage(h.threadId, '整理目录'), 'turn');
  await waitFor(() => calls.length === 1);
  assert.equal(h.kernel.sendMessage(h.threadId, '只看 md 文件'), 'steer');
  release();
  await waitIdle(h, 1);
  assert.equal(calls.length, 2);
  assert.equal(lastUserText(calls[1]!), '只看 md 文件');
  const messages = h.kernel.listMessages(h.threadId);
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'user', 'assistant'],
  );
  assert.equal(messages[2]!.blocks[0]!.type, 'tool_result');
  assert.equal(texts([messages[3]!])[0], '只看 md 文件');
  // 整个过程只有一轮
  assert.equal(h.events.filter((e) => e.type === 'turn' && e.state === 'running').length, 1);
  await h.close();
});

test('插话：模型本来要结束时有插话，接着在同一轮里再调用一次', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: ModelRequest[] = [];
  const model: CallModel = async ({ request }) => {
    calls.push(structuredClone(request));
    if (calls.length === 1) await gate;
    return {
      blocks: [{ type: 'text', text: `回复${calls.length}` }],
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  };
  const h = await kernelHarness(model);
  h.kernel.sendMessage(h.threadId, '一');
  await waitFor(() => calls.length === 1);
  h.kernel.sendMessage(h.threadId, '二');
  release();
  await waitIdle(h, 1);
  assert.deepEqual(texts(h.kernel.listMessages(h.threadId)), ['一', '回复1', '二', '回复2']);
  assert.equal(h.events.filter((e) => e.type === 'turn' && e.state === 'running').length, 1);
  await h.close();
});

test('插话：中止后，尚未插入的消息作为新一轮发送', async () => {
  const calls: ModelRequest[] = [];
  const model: CallModel = async ({ request, signal }) => {
    calls.push(structuredClone(request));
    if (calls.length === 1) {
      if (signal.aborted) throw new Error('aborted');
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return { blocks: [{ type: 'text', text: '好的' }], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const h = await kernelHarness(model);
  h.kernel.sendMessage(h.threadId, '一');
  await waitFor(() => calls.length === 1);
  assert.equal(h.kernel.sendMessage(h.threadId, '二'), 'steer');
  h.kernel.abort(h.threadId);
  await waitIdle(h, 2);
  assert.equal(calls.length, 2);
  assert.equal(lastUserText(calls[1]!), '二');
  await h.close();
});

test('记忆开关：关闭后系统提示不含记忆主题与记忆约定，用户画像仍在', () => {
  const bot = newBot('b1', 'p1', 'm');
  bot.persona = '我是测试';
  const args = {
    bot,
    workspace: '/w',
    userMd: '喜欢咖啡',
    userMdPath: '/u.md',
    memoryDir: '/mem',
    topics: [{ name: '项目', summary: '项目约定' }],
    platform: 'linux' as const,
    now: new Date(0),
  };
  const on = buildSystemPrompt(args);
  assert.match(on, /记忆主题/);
  assert.match(on, /项目约定/);
  bot.memoryEnabled = false;
  const off = buildSystemPrompt(args);
  assert.doesNotMatch(off, /记忆主题/);
  assert.doesNotMatch(off, /记忆约定/);
  assert.doesNotMatch(off, /项目约定/);
  assert.match(off, /喜欢咖啡/);
});

test('记忆开关：kernel 把开关传到系统提示；新 bot 默认开启', async () => {
  const systems: string[] = [];
  const h = await kernelHarness(async ({ request }) => {
    systems.push(request.system);
    return { blocks: [{ type: 'text', text: 'x' }], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } };
  });
  assert.equal(h.bot.memoryEnabled, true);
  await h.kernel.updateBot(h.bot.id, { memoryEnabled: false });
  h.kernel.sendMessage(h.threadId, '你好');
  await waitIdle(h);
  assert.doesNotMatch(systems[0]!, /记忆主题/);
  assert.equal(h.kernel.memoryDir(h.bot.id), path.join(h.root, 'bots', h.bot.id, 'memory'));
  await assert.rejects(h.kernel.updateBot(h.bot.id, { memoryEnabled: 'no' as never }));
  await h.close();
});

test('记忆开关：后台整理跳过关闭记忆的 bot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-memsw-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.memoryDir('b1'), { recursive: true });
  const db = openDb(paths.db);
  const bot = newBot('b1', 'p1', 'm');
  bot.memoryEnabled = false;
  await saveBot(paths, bot);
  const thread = createThread(db, 'b1', 't');
  appendMessage(db, { threadId: thread.id, role: 'user', blocks: [{ type: 'text', text: '记住我叫小王' }], kind: null, interrupted: false });
  updateThread(db, thread.id, { lastActivityAt: 0 });
  let calls = 0;
  const consolidator = new Consolidator({
    db,
    paths,
    revisions: new MemoryRevisions(db, paths),
    secrets: new SecretSet(),
    callModel: async () => {
      calls += 1;
      return { blocks: [{ type: 'text', text: '{"files":[]}' }], stopReason: 'end', usage: { inputTokens: 0, outputTokens: 0 } };
    },
    resolveConsolidationModel: (b) => ({
      provider: { id: 'p1', name: 'p', format: 'chat_completions', baseUrl: 'http://x' },
      apiKey: 'k',
      model: b.model,
    }),
    loadBot: (id) => loadBot(paths, id),
    isThreadRunning: () => false,
    emit: () => {},
    now: () => IDLE_MS * 10,
  });
  await consolidator.scan();
  await consolidator.consolidateThread(thread.id);
  assert.equal(calls, 0);
  db.close();
});
