import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths } from '../src/paths.ts';
import { openDb } from '../src/db/db.ts';
import { createThread, getThread, updateThread } from '../src/db/threads.ts';
import { appendMessage } from '../src/db/messages.ts';
import { newBot, saveBot, loadBot } from '../src/config/config.ts';
import { MemoryRevisions } from '../src/memory/revisions.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import {
  Consolidator,
  IDLE_MS,
  type ConsolidatorDeps,
} from '../src/memory/consolidate.ts';
import type { ModelRequest } from '../src/model/adapter.ts';
import type { KernelEvent } from '../src/events.ts';
import type { Bot } from '../src/config/types.ts';

interface Harness {
  root: string;
  paths: ReturnType<typeof dataPaths>;
  db: ReturnType<typeof openDb>;
  bot: Bot;
  threadId: string;
  deps: ConsolidatorDeps;
  consolidator: Consolidator;
  calls: ModelRequest[];
  events: KernelEvent[];
  secrets: SecretSet;
  revisions: MemoryRevisions;
  running: Set<string>;
  add(text: string, threadId?: string): number;
  addThread(): string;
  close(): void;
}

async function setup(opts: {
  now?: number;
  reply: (request: ModelRequest, signal: AbortSignal) => string | Promise<string>;
  consolidationModel?: { providerId: string; model: string } | null;
  running?: Set<string>;
  contextWindow?: number;
  maxOutputTokens?: number;
}): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-consolidate-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.defaultWorkspace('b1'), { recursive: true });
  await fs.mkdir(paths.memoryDir('b1'), { recursive: true });
  const db = openDb(paths.db);
  const bot = newBot('b1', 'p1', 'm');
  await saveBot(paths, bot);
  const thread = createThread(db, 'b1', 't');
  const calls: ModelRequest[] = [];
  const events: KernelEvent[] = [];
  const secrets = new SecretSet();
  const revisions = new MemoryRevisions(db, paths);
  const running = opts.running ?? new Set<string>();
  const provider = { id: 'p1', name: 'p', format: 'chat_completions' as const, baseUrl: 'http://x' };
  const deps: ConsolidatorDeps = {
    db,
    paths,
    revisions,
    secrets,
    callModel: async (a) => {
      calls.push(a.request);
      const text = await opts.reply(a.request, a.signal);
      return {
        blocks: [{ type: 'text', text }],
        stopReason: 'end',
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    resolveConsolidationModel: (b) => ({
      provider,
      apiKey: 'sk-test-secret-123',
      model: opts.consolidationModel?.model ?? b.model,
      contextWindow: opts.contextWindow ?? b.contextWindow,
      maxOutputTokens: opts.maxOutputTokens ?? b.maxOutputTokens,
    }),
    loadBot: (id) => loadBot(paths, id),
    isThreadRunning: (id) => running.has(id),
    emit: (e) => events.push(e),
    now: () => opts.now ?? Date.now(),
  };
  const consolidator = new Consolidator(deps);
  const add = (text: string, threadId = thread.id): number =>
    appendMessage(db, {
      threadId,
      role: 'user',
      blocks: [{ type: 'text', text }],
      kind: null,
      interrupted: false,
    }).id;
  const addThread = (): string => createThread(db, 'b1', 't2').id;
  return {
    root,
    paths,
    db,
    bot,
    threadId: thread.id,
    deps,
    consolidator,
    calls,
    events,
    secrets,
    revisions,
    running,
    add,
    addThread,
    close: () => db.close(),
  };
}

function replyJson(user: string | null, topics: { name: string; content: string }[]): string {
  return JSON.stringify({ user, topics });
}

function messageTexts(request: ModelRequest): string[] {
  return request.messages.flatMap((m) =>
    m.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text),
  );
}

test('扫描：只处理空闲超过 10 分钟、有未整理消息、且没在运行的线程', async () => {
  const now = 10_000_000;
  const h = await setup({ now, reply: () => replyJson(null, []) });
  const idleThread = h.threadId;
  const msg = h.add('空闲线程消息');
  updateThread(h.db, idleThread, { lastActivityAt: now - IDLE_MS - 1 });

  const recent = h.addThread();
  h.add('最近消息', recent);
  updateThread(h.db, recent, { lastActivityAt: now - 1000 });

  const empty = h.addThread();

  const busy = h.addThread();
  h.add('运行中消息', busy);
  updateThread(h.db, busy, { lastActivityAt: now - IDLE_MS - 1 });
  h.running.add(busy);

  await h.consolidator.scan();
  assert.equal(h.calls.length, 1);
  assert.equal(getThread(h.db, idleThread)!.lastExtractedMsgId, msg);
  assert.equal(getThread(h.db, recent)!.lastExtractedMsgId, 0);
  assert.equal(getThread(h.db, empty)!.lastExtractedMsgId, 0);
  assert.equal(getThread(h.db, busy)!.lastExtractedMsgId, 0);
  h.close();
});

test('增量：只把 last_extracted_msg_id 之后的消息发给模型；成功后推进该值', async () => {
  const now = Date.now();
  const h = await setup({ now, reply: () => replyJson(null, []) });
  const msg1 = h.add('旧消息');
  updateThread(h.db, h.threadId, { lastExtractedMsgId: msg1 });
  const msg2 = h.add('新消息一');
  const msg3 = h.add('新消息二');
  await h.consolidator.consolidateThread(h.threadId);
  const texts = messageTexts(h.calls[0]!);
  assert.equal(texts.length, 1);
  assert.ok(texts[0]!.includes('新消息一') && texts[0]!.includes('新消息二'));
  assert.equal(texts[0]!.includes('旧消息'), false);
  assert.equal(getThread(h.db, h.threadId)!.lastExtractedMsgId, msg3);
  assert.equal(msg2 < msg3, true);
  h.close();
});

test('写入记 source "consolidation"，actor 为该 bot id', async () => {
  const h = await setup({
    reply: () => replyJson(null, [{ name: '工作', content: '> 简介：项目\n正文' }]),
  });
  h.add('聊到项目');
  await h.consolidator.consolidateThread(h.threadId);
  const file = path.join(h.paths.memoryDir('b1'), '工作.md');
  assert.equal(await fs.readFile(file, 'utf8'), '> 简介：项目\n正文');
  const list = h.revisions.list(file);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.source, 'consolidation');
  assert.equal(list[0]!.actor, 'b1');
  assert.equal(
    h.events.some((e) => e.type === 'memory_changed' && e.path === file),
    true,
  );
  h.close();
});

test('写回前哈希不一致（读取后被前台改了）→ 跳过该文件、不推进 last_extracted_msg_id', async () => {
  const h = await setup({
    reply: async () => {
      await fs.writeFile(h.paths.userMd, '前台修改');
      return replyJson('模型内容', []);
    },
  });
  await fs.writeFile(h.paths.userMd, '原内容');
  const msg = h.add('聊天');
  await h.consolidator.consolidateThread(h.threadId);
  assert.equal(await fs.readFile(h.paths.userMd, 'utf8'), '前台修改');
  assert.equal(getThread(h.db, h.threadId)!.lastExtractedMsgId, 0);
  assert.equal(h.revisions.list(h.paths.userMd).length, 0);
  assert.equal(msg > 0, true);
  h.close();
});

test('不合规的条目被跳过：非法主题名、缺首行简介、含已知 Key；其余条目照常写入', async () => {
  const h = await setup({
    reply: () =>
      replyJson(null, [
        { name: 'C++/Rust', content: '> 简介：Rust\nx' },
        { name: 'a:b', content: '> 简介：冒号\nx' },
        { name: '无简介', content: '正文' },
        { name: '含密钥', content: '> 简介：x\nsk-12345678' },
        { name: '工作', content: '> 简介：项目\n正文' },
      ]),
  });
  h.secrets.add('sk-12345678');
  h.add('聊天');
  await h.consolidator.consolidateThread(h.threadId);
  assert.deepEqual(await fs.readdir(h.paths.memoryDir('b1')), ['工作.md']);
  assert.equal(
    await fs.readFile(path.join(h.paths.memoryDir('b1'), '工作.md'), 'utf8'),
    '> 简介：项目\n正文',
  );
  assert.equal(getThread(h.db, h.threadId)!.lastExtractedMsgId > 0, true);
  h.close();
});

test('模型回复包在 ```json 围栏里也能解析', async () => {
  const payload = replyJson(null, [{ name: '工作', content: '> 简介：项目\n正文' }]);
  const h = await setup({ reply: () => `\`\`\`json\n${payload}\n\`\`\`` });
  h.add('聊天');
  await h.consolidator.consolidateThread(h.threadId);
  const file = path.join(h.paths.memoryDir('b1'), '工作.md');
  assert.equal(await fs.readFile(file, 'utf8'), '> 简介：项目\n正文');
  h.close();
});

test('完全无法解析时什么都不写', async () => {
  const h = await setup({ reply: () => '这不是 JSON' });
  h.add('聊天');
  await h.consolidator.consolidateThread(h.threadId);
  assert.deepEqual(await fs.readdir(h.paths.memoryDir('b1')), []);
  assert.equal(getThread(h.db, h.threadId)!.lastExtractedMsgId, 0);
  h.close();
});

test('解析失败或模型调用失败后，该线程要等有新消息才重试：下一次 scan 跳过它，追加一条消息后的 scan 再处理', async () => {
  const now = 10_000_000;
  let attempt = 0;
  const h = await setup({
    now,
    reply: () => {
      attempt += 1;
      if (attempt === 1) throw new Error('模型调用失败');
      return replyJson(null, []);
    },
  });
  const msg1 = h.add('第一条');
  updateThread(h.db, h.threadId, { lastActivityAt: now - IDLE_MS - 1 });
  await h.consolidator.scan();
  assert.equal(h.calls.length, 1);
  assert.equal(getThread(h.db, h.threadId)!.lastExtractedMsgId, 0);

  await h.consolidator.scan();
  assert.equal(h.calls.length, 1);

  h.add('第二条');
  await h.consolidator.scan();
  assert.equal(h.calls.length, 2);
  assert.equal(getThread(h.db, h.threadId)!.lastExtractedMsgId > msg1, true);
  h.close();
});

test('配置了 consolidationModel 时用它，否则用 bot 自己的模型', async () => {
  const h1 = await setup({
    reply: () => replyJson(null, []),
    consolidationModel: { providerId: 'p1', model: 'backend-model' },
  });
  h1.add('聊天');
  await h1.consolidator.consolidateThread(h1.threadId);
  assert.equal(h1.calls[0]!.model, 'backend-model');
  h1.close();

  const h2 = await setup({ reply: () => replyJson(null, []), consolidationModel: null });
  h2.add('聊天');
  await h2.consolidator.consolidateThread(h2.threadId);
  assert.equal(h2.calls[0]!.model, h2.bot.model);
  h2.close();
});

test('提示词含 "合并重复" 与 "新事实与旧记录冲突时直接覆盖旧条目"', async () => {
  const h = await setup({ reply: () => replyJson(null, []) });
  h.add('聊天');
  await h.consolidator.consolidateThread(h.threadId);
  assert.ok(h.calls[0]!.system.includes('合并重复'));
  assert.ok(h.calls[0]!.system.includes('新事实与旧记录冲突时直接覆盖旧条目'));
  h.close();
});

test('start/stop 不抛错，且 scan 可重复调用', async () => {
  const h = await setup({ reply: () => replyJson(null, []) });
  h.consolidator.start();
  await h.consolidator.scan();
  await h.consolidator.stop();
  await h.consolidator.stop();
  h.close();
});

test('增量过大时按批处理：每批只取放得进窗口的前一段，成功后推进到这批末尾，其余下次再整理', async () => {
  const h = await setup({ reply: () => replyJson(null, []), contextWindow: 4000 });
  const ids: number[] = [];
  for (let i = 0; i < 10; i++) ids.push(h.add(`消息${i}${'a'.repeat(1750)}`));
  await h.consolidator.consolidateThread(h.threadId);
  const first = messageTexts(h.calls[0]!)[0]!;
  assert.ok(first.includes('消息0') && !first.includes('消息9'));
  const advanced = getThread(h.db, h.threadId)!.lastExtractedMsgId;
  assert.ok(advanced > ids[0]! && advanced < ids[9]!);
  await h.consolidator.consolidateThread(h.threadId);
  const second = messageTexts(h.calls[1]!)[0]!;
  assert.equal(second.includes('消息0'), false);
  assert.ok(second.includes(`消息${ids.indexOf(advanced) + 1}`));
  for (let i = 0; i < 5; i++) await h.consolidator.consolidateThread(h.threadId);
  assert.equal(getThread(h.db, h.threadId)!.lastExtractedMsgId, ids[9]);
  h.close();
});

test('maxTokens 用整理模型的上限，而不是 bot 的', async () => {
  const h = await setup({ reply: () => replyJson(null, []), maxOutputTokens: 1234 });
  h.add('聊天');
  await h.consolidator.consolidateThread(h.threadId);
  assert.equal(h.calls[0]!.maxTokens, 1234);
  h.close();
});

test('模型返回空白的 user 时不清空 user.md', async () => {
  const h = await setup({ reply: () => replyJson('  \n', []) });
  await fs.writeFile(h.paths.userMd, '用户喜欢咖啡', 'utf8');
  h.add('聊天');
  await h.consolidator.consolidateThread(h.threadId);
  assert.equal(await fs.readFile(h.paths.userMd, 'utf8'), '用户喜欢咖啡');
  h.close();
});

test('stop() 中止进行中的整理并等它结束，不推进进度', async () => {
  const h = await setup({
    reply: (_request, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
  h.add('聊天');
  const job = h.consolidator.consolidateThread(h.threadId);
  while (h.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  await h.consolidator.stop();
  await job;
  assert.equal(getThread(h.db, h.threadId)!.lastExtractedMsgId, 0);
  await h.consolidator.consolidateThread(h.threadId);
  assert.equal(h.calls.length, 1);
  h.close();
});
