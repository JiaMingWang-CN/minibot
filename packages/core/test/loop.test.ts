import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths } from '../src/paths.ts';
import { openDb } from '../src/db/db.ts';
import { createThread, getThread } from '../src/db/threads.ts';
import { messagesFrom, appendMessage } from '../src/db/messages.ts';
import { newBot } from '../src/config/config.ts';
import { MemoryRevisions } from '../src/memory/revisions.ts';
import { SecretSet, REDACTED } from '../src/secrets/redact.ts';
import { ReadTracker } from '../src/tools/read-tracker.ts';
import { ApprovalBroker } from '../src/approval/broker.ts';
import type { ToolEnv } from '../src/tools/registry.ts';
import {
  MAX_TOOL_ROUNDS,
  runTurn,
  type TurnDeps,
} from '../src/agent/loop.ts';
import { buildSystemPrompt } from '../src/agent/prompt.ts';
import { ThreadQueue } from '../src/agent/queue.ts';
import type { CallModel } from '../src/model/client.ts';
import type { ModelRequest } from '../src/model/adapter.ts';
import type { Block, StoredMessage } from '../src/model/types.ts';
import { ToolCatalog, type ExternalTool, type TurnToolset } from '../src/tools/catalog.ts';
import { AbortedError, ModelError } from '../src/model/types.ts';
import type { KernelEvent } from '../src/events.ts';
import type { Bot } from '../src/config/types.ts';

const isWin = process.platform === 'win32';

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await sleep(5);
  }
}

interface Harness {
  root: string;
  paths: ReturnType<typeof dataPaths>;
  db: ReturnType<typeof openDb>;
  bot: Bot;
  threadId: string;
  env: ToolEnv;
  controller: AbortController;
  deps: TurnDeps;
  events: KernelEvent[];
  calls: ModelRequest[];
  close(): void;
}

async function harness(
  model: CallModel,
  opts: { approvalMode?: 'ask' | 'auto'; snapshotTools?: (bot: Bot) => Promise<TurnToolset> } = {},
): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-loop-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.defaultWorkspace('b1'), { recursive: true });
  await fs.mkdir(paths.memoryDir('b1'), { recursive: true });
  const db = openDb(paths.db);
  const bot = newBot('b1', 'p1', 'm');
  bot.approvalMode = opts.approvalMode ?? 'auto';
  const thread = createThread(db, 'b1', 't');
  const controller = new AbortController();
  const events: KernelEvent[] = [];
  const calls: ModelRequest[] = [];
  const secrets = new SecretSet();
  const env: ToolEnv = {
    bot,
    threadId: thread.id,
    workspace: paths.defaultWorkspace('b1'),
    paths,
    home: root,
    tracker: new ReadTracker(),
    secrets,
    revisions: new MemoryRevisions(db, paths),
    broker: new ApprovalBroker(() => {}),
    signal: controller.signal,
  };
  const deps: TurnDeps = {
    db,
    callModel: async (a) => {
      calls.push(a.request);
      return model(a);
    },
    emit: (e) => events.push(e),
    resolveModel: () => ({
      provider: { id: 'p1', name: 'p', format: 'chat_completions', baseUrl: 'http://x' },
      apiKey: 'sk-test-secret-123',
    }),
    makeToolEnv: () => env,
    prepareContext: async (threadId) => messagesFrom(db, threadId, 0),
    ...(opts.snapshotTools !== undefined ? { snapshotTools: opts.snapshotTools } : {}),
  };
  return {
    root,
    paths,
    db,
    bot,
    threadId: thread.id,
    env,
    controller,
    deps,
    events,
    calls,
    close: () => db.close(),
  };
}

function assistantText(message: StoredMessage): string {
  return message.blocks
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

test('纯文本一轮：存入 user + assistant 两条消息，发出 turn running → idle', async () => {
  const h = await harness(async ({ onDelta }) => {
    onDelta({ type: 'text', text: '你好' });
    return {
      blocks: [{ type: 'text', text: '你好' }],
      stopReason: 'end',
      usage: { inputTokens: 10, outputTokens: 2 },
    };
  });
  await runTurn(h.deps, h.bot, h.threadId, '在吗', h.controller.signal);
  const messages = messagesFrom(h.db, h.threadId, 0);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, 'user');
  assert.equal(assistantText(messages[0]!), '在吗');
  assert.equal(messages[1]!.role, 'assistant');
  assert.equal(assistantText(messages[1]!), '你好');
  const turnEvents = h.events.filter((e) => e.type === 'turn');
  assert.deepEqual(turnEvents.map((e) => (e as { state: string }).state), ['running', 'idle']);
  h.close();
});

test('工具轮：tool_use → 执行 → 一条 user 消息带全部 tool_result → 再次调用模型 → 结束', async () => {
  let n = 0;
  const h = await harness(async () => {
    n += 1;
    if (n === 1) {
      return {
        blocks: [
          { type: 'tool_use', id: 'tu_a', name: 'read_file', input: { path: 'a.txt' } },
          { type: 'tool_use', id: 'tu_b', name: 'read_file', input: { path: 'b.txt' } },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    return {
      blocks: [{ type: 'text', text: '完成' }],
      stopReason: 'end',
      usage: { inputTokens: 2, outputTokens: 1 },
    };
  });
  await fs.writeFile(path.join(h.env.workspace, 'a.txt'), 'AAA');
  await fs.writeFile(path.join(h.env.workspace, 'b.txt'), 'BBB');
  await runTurn(h.deps, h.bot, h.threadId, '读两个文件', h.controller.signal);
  const messages = messagesFrom(h.db, h.threadId, 0);
  assert.equal(messages.length, 4);
  assert.equal(messages[1]!.role, 'assistant');
  assert.equal(messages[2]!.role, 'user');
  const results = messages[2]!.blocks.filter((b) => b.type === 'tool_result');
  assert.equal(results.length, 2);
  assert.ok(results.every((b) => (b as { status: string }).status === 'ok'));
  assert.ok(results.some((b) => (b as { content: string }).content.includes('AAA')));
  assert.equal(n, 2);
  const lastRequest = h.calls[1]!;
  const lastMessage = lastRequest.messages[lastRequest.messages.length - 1]!;
  assert.equal(lastMessage.role, 'user');
  assert.equal(lastMessage.blocks.filter((b) => b.type === 'tool_result').length, 2);
  h.close();
});

test('同一线程严格串行；不同线程并行', async () => {
  const queue = new ThreadQueue();
  const order: string[] = [];
  let releaseA: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const first = queue.enqueue('t1', async () => {
    order.push('a-start');
    await gate;
    order.push('a-end');
  });
  const second = queue.enqueue('t1', async () => {
    order.push('b-start');
  });
  await waitUntil(() => order.length > 0);
  assert.equal(order[0], 'a-start');
  assert.equal(queue.isRunning('t1'), true);
  await sleep(20);
  assert.equal(order.includes('b-start'), false);
  releaseA?.();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start']);

  let active = 0;
  let maxActive = 0;
  let releaseBoth: (() => void) | undefined;
  const bothGate = new Promise<void>((resolve) => {
    releaseBoth = resolve;
  });
  const job = async (): Promise<void> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await bothGate;
    active -= 1;
  };
  const p1 = queue.enqueue('x1', job);
  const p2 = queue.enqueue('x2', job);
  await waitUntil(() => maxActive === 2);
  assert.equal(queue.isRunning('x1'), true);
  assert.equal(queue.isRunning('x2'), true);
  releaseBoth?.();
  await Promise.all([p1, p2]);
});

test('模型输出中途 abort：保存部分回复并标 interrupted；完整的 tool_use 补 cancelled', async () => {
  const h = await harness(
    async ({ signal, onDelta }) => {
      onDelta({ type: 'text', text: '部分' });
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () =>
            reject(
              new AbortedError([
                { type: 'text', text: '部分' },
                { type: 'tool_use', id: 'tu_x', name: 'read_file', input: { path: 'x' } },
              ]),
            ),
          { once: true },
        );
      });
    },
  );
  const promise = runTurn(h.deps, h.bot, h.threadId, '开始', h.controller.signal);
  await sleep(50);
  h.controller.abort();
  await promise;
  const messages = messagesFrom(h.db, h.threadId, 0);
  const assistant = messages.find((m) => m.role === 'assistant')!;
  assert.equal(assistant.interrupted, true);
  const results = messages.filter((m) => m.blocks.some((b) => b.type === 'tool_result'));
  assert.equal(results.length, 1);
  assert.ok(
    results[0]!.blocks.some(
      (b) => b.type === 'tool_result' && b.toolUseId === 'tu_x' && b.status === 'cancelled',
    ),
  );
  assert.ok(messages.some((m) => m.kind === 'notice' && assistantText(m).includes('已中断')));
  h.close();
});

test('工具执行中 abort：当前和剩余的 tool_use 都记为 cancelled，历史合法', async () => {
  const command = isWin ? 'Start-Sleep -Seconds 5' : 'sleep 5';
  let n = 0;
  const h = await harness(async () => {
    n += 1;
    return {
      blocks: [
        { type: 'tool_use', id: 'tu_c1', name: 'run_command', input: { command } },
        { type: 'tool_use', id: 'tu_c2', name: 'run_command', input: { command } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  const promise = runTurn(h.deps, h.bot, h.threadId, '跑命令', h.controller.signal);
  await sleep(300);
  h.controller.abort();
  await promise;
  const messages = messagesFrom(h.db, h.threadId, 0);
  const resultMessage = messages.find(
    (m) => m.role === 'user' && m.blocks.some((b) => b.type === 'tool_result'),
  )!;
  const results = resultMessage.blocks.filter((b) => b.type === 'tool_result');
  assert.equal(results.length, 2);
  assert.ok(results.every((b) => (b as { status: string }).status === 'cancelled'));
  assert.equal(n, 1);
  h.close();
});

test('模型抛 ModelError（Review Focus 4）：保存 partial、补齐工具结果、追加 notice；下一轮不含 notice 且能完成', async () => {
  let n = 0;
  const h = await harness(async () => {
    n += 1;
    if (n === 1) {
      throw new ModelError('stream', '连接断开', {
        partial: [
          { type: 'text', text: '部分' },
          { type: 'tool_use', id: 'tu_partial', name: 'read_file', input: { path: 'no.txt' } },
        ],
      });
    }
    return {
      blocks: [{ type: 'text', text: '继续成功' }],
      stopReason: 'end',
      usage: { inputTokens: 3, outputTokens: 1 },
    };
  });
  await runTurn(h.deps, h.bot, h.threadId, '第一轮', h.controller.signal);
  let messages = messagesFrom(h.db, h.threadId, 0);
  const notice = messages.find((m) => m.kind === 'notice')!;
  assert.ok(assistantText(notice).includes('模型调用失败'));
  assert.ok(
    messages.some((m) =>
      m.blocks.some((b) => b.type === 'tool_result' && b.toolUseId === 'tu_partial'),
    ),
  );

  await runTurn(h.deps, h.bot, h.threadId, '第二轮', h.controller.signal);
  messages = messagesFrom(h.db, h.threadId, 0);
  const last = messages[messages.length - 1]!;
  assert.equal(last.role, 'assistant');
  assert.equal(assistantText(last), '继续成功');
  assert.equal(h.calls[1]!.messages.some((m) => m.kind === 'notice'), false);
  h.close();
});

test('超过 MAX_TOOL_ROUNDS 时停止并给出 notice', async () => {
  let n = 0;
  const h = await harness(async () => {
    n += 1;
    return {
      blocks: [
        { type: 'tool_use', id: `tu_${n}`, name: 'read_file', input: { path: 'a.txt' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  await fs.writeFile(path.join(h.env.workspace, 'a.txt'), 'x');
  await runTurn(h.deps, h.bot, h.threadId, '一直读', h.controller.signal);
  const messages = messagesFrom(h.db, h.threadId, 0);
  assert.equal(h.calls.length, MAX_TOOL_ROUNDS);
  const last = messages[messages.length - 1]!;
  assert.equal(last.kind, 'notice');
  assert.ok(assistantText(last).includes(String(MAX_TOOL_ROUNDS)));
  h.close();
});

test('stopReason max_tokens：保存已有内容，丢弃不完整的工具调用，追加 notice "输出达到长度上限，已截断"', async () => {
  const h = await harness(async () => ({
    blocks: [
      { type: 'text', text: '已写一半' },
      { type: 'tool_use', id: 'tu_incomplete', name: 'write_file', input: { path: 'x', content: 'y' } },
    ],
    stopReason: 'max_tokens',
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  await runTurn(h.deps, h.bot, h.threadId, '写文件', h.controller.signal);
  const messages = messagesFrom(h.db, h.threadId, 0);
  const assistant = messages.find((m) => m.role === 'assistant')!;
  assert.deepEqual(assistant.blocks, [{ type: 'text', text: '已写一半' }]);
  const notice = messages[messages.length - 1]!;
  assert.equal(notice.kind, 'notice');
  assert.equal(assistantText(notice), '输出达到长度上限，已截断');
  assert.equal(
    messages.some((m) => m.blocks.some((b) => b.type === 'tool_result')),
    false,
  );
  h.close();
});

test('400 且错误信息提到 max_tokens：notice 为 "输出上限超过模型允许值，请在 bot 设置里调小"', async () => {
  const h = await harness(async () => {
    throw new ModelError('bad_request', 'maximum output tokens exceeded', { status: 400 });
  });
  await runTurn(h.deps, h.bot, h.threadId, '生成', h.controller.signal);
  const messages = messagesFrom(h.db, h.threadId, 0);
  const notice = messages[messages.length - 1]!;
  assert.equal(notice.kind, 'notice');
  assert.equal(assistantText(notice), '输出上限超过模型允许值，请在 bot 设置里调小');
  h.close();
});

test('每次模型调用后，把 usage.inputTokens 与本次请求的最后一条消息 id 记到线程上', async () => {
  const h = await harness(async () => ({
    blocks: [{ type: 'text', text: '好' }],
    stopReason: 'end',
    usage: { inputTokens: 123, outputTokens: 4 },
  }));
  await runTurn(h.deps, h.bot, h.threadId, '统计', h.controller.signal);
  const thread = getThread(h.db, h.threadId)!;
  const messages = messagesFrom(h.db, h.threadId, 0);
  assert.equal(thread.lastInputTokens, 123);
  assert.equal(thread.lastInputMsgId, messages[0]!.id);
  assert.ok(thread.lastActivityAt > 0);
  h.close();
});

test('模型生成的文本落库前经过脱敏', async () => {
  const key = 'sk-loop-secret-123456';
  const h = await harness(async ({ onDelta }) => {
    onDelta({ type: 'text', text: `delta ${key}` });
    return {
      blocks: [{ type: 'text', text: `回答 ${key} 完` }],
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  h.env.secrets.add(key);
  await runTurn(h.deps, h.bot, h.threadId, '问', h.controller.signal);
  const messages = messagesFrom(h.db, h.threadId, 0);
  const assistant = messages.find((m) => m.role === 'assistant')!;
  assert.ok(assistantText(assistant).includes(REDACTED));
  assert.equal(assistantText(assistant).includes(key), false);
  const messageEvent = h.events.find(
    (e) => e.type === 'message' && e.message.role === 'assistant',
  ) as Extract<KernelEvent, { type: 'message' }> | undefined;
  assert.ok(messageEvent !== undefined);
  assert.equal(assistantText(messageEvent.message).includes(key), false);
  const deltaEvent = h.events.find((e) => e.type === 'delta') as Extract<KernelEvent, { type: 'delta' }>;
  assert.equal(deltaEvent.delta.text.includes(key), false);
  h.close();
});

test('Key 被切在两个流式增量之间也不会漏出；结束时放出剩余', async () => {
  const key = 'sk-loop-secret-123456';
  const h = await harness(async ({ onDelta }) => {
    onDelta({ type: 'text', text: '前缀 sk-loop-sec' });
    onDelta({ type: 'text', text: 'ret-123456 后缀 sk-lo' });
    onDelta({ type: 'reasoning', text: '想 sk-loop' });
    return {
      blocks: [{ type: 'text', text: '前缀 x' }],
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  h.env.secrets.add(key);
  await runTurn(h.deps, h.bot, h.threadId, '问', h.controller.signal);
  const deltas = h.events.filter((e) => e.type === 'delta') as Extract<KernelEvent, { type: 'delta' }>[];
  const textOf = (type: string): string => deltas.filter((e) => e.delta.type === type).map((e) => e.delta.text).join('');
  assert.equal(textOf('text'), `前缀 ${REDACTED} 后缀 sk-lo`);
  assert.equal(textOf('reasoning'), '想 sk-loop');
  for (const e of deltas) assert.equal(e.delta.text.includes('sk-loop-sec'), false);
  h.close();
});

test('系统提示词含人设、工作目录、user.md 全文、主题名与简介（无简介写 "无简介"）、首行约定 "> 简介："、"记住" 的写法', () => {
  const prompt = buildSystemPrompt({
    bot: { ...newBot('b1'), persona: '我是一名人设甲助理。' },
    workspace: '/ws/dir',
    userMd: '用户喜欢咖啡。',
    userMdPath: '/data/user.md',
    memoryDir: '/data/memory',
    topics: [
      { name: '工作', summary: '项目 A' },
      { name: '随笔', summary: null },
    ],
    platform: 'win32',
    now: new Date('2026-11-08T00:00:00Z'),
  });
  assert.ok(prompt.includes('我是一名人设甲助理。'));
  assert.ok(prompt.includes('/ws/dir'));
  assert.ok(prompt.includes('用户喜欢咖啡。'));
  assert.ok(prompt.includes('工作'));
  assert.ok(prompt.includes('项目 A'));
  assert.ok(prompt.includes('随笔'));
  assert.ok(prompt.includes('无简介'));
  assert.ok(prompt.includes('> 简介：'));
  assert.ok(prompt.includes('记住'));
});

function echoExternalTool(): ExternalTool {
  return {
    spec: { name: 'fake__echo', description: '回显', parameters: { type: 'object', properties: {} } },
    source: { kind: 'mcp', serverId: 's1', serverName: 'S1', toolName: 'echo' },
    summarize: () => '调用 fake__echo',
    run: async (input) => ({ content: `echo:${String(input['text'] ?? '')}`, isError: false }),
  };
}

test('本轮使用快照：第一次 callModel 后 provider 不再提供，本轮仍执行；下一轮报未知工具', async () => {
  let available = true;
  let n = 0;
  const catalog = new ToolCatalog();
  catalog.register({ toolsFor: async () => (available ? [echoExternalTool()] : []) });
  const h = await harness(
    async () => {
      n += 1;
      if (n % 2 === 1) {
        if (n === 1) available = false;
        return {
          blocks: [{ type: 'tool_use', id: `tu_${n}`, name: 'fake__echo', input: { text: 'hi' } }],
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      return { blocks: [{ type: 'text', text: '完成' }], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } };
    },
    { approvalMode: 'auto', snapshotTools: (bot) => catalog.snapshot(bot) },
  );

  await runTurn(h.deps, h.bot, h.threadId, '第一轮', h.controller.signal);
  let messages = messagesFrom(h.db, h.threadId, 0);
  const firstResult = messages.flatMap((m) => m.blocks).find((b) => b.type === 'tool_result');
  assert.ok(firstResult !== undefined);
  assert.equal((firstResult as { content: string }).content, 'echo:hi');

  await runTurn(h.deps, h.bot, h.threadId, '第二轮', h.controller.signal);
  messages = messagesFrom(h.db, h.threadId, 0);
  const results = messages
    .flatMap((m) => m.blocks)
    .filter((b): b is Extract<Block, { type: 'tool_result' }> => b.type === 'tool_result');
  assert.ok(results.some((r) => r.content.startsWith('未知工具：fake__echo')));
  h.close();
});

test('历史里有已消失外部工具的 tool_use / tool_result：原样发送给模型', async () => {
  const catalog = new ToolCatalog();
  const h = await harness(
    async () => ({ blocks: [{ type: 'text', text: '好的' }], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } }),
    { approvalMode: 'auto', snapshotTools: (bot) => catalog.snapshot(bot) },
  );
  appendMessage(h.db, {
    threadId: h.threadId,
    role: 'assistant',
    blocks: [{ type: 'tool_use', id: 'tu_old', name: 'old__tool', input: { x: 1 } }],
    kind: null,
    interrupted: false,
  });
  appendMessage(h.db, {
    threadId: h.threadId,
    role: 'user',
    blocks: [{ type: 'tool_result', toolUseId: 'tu_old', content: '旧结果', status: 'ok' }],
    kind: null,
    interrupted: false,
  });
  await runTurn(h.deps, h.bot, h.threadId, '继续', h.controller.signal);
  const sent = h.calls[0]!.messages;
  assert.ok(sent.some((m) => m.blocks.some((b) => b.type === 'tool_use' && b.name === 'old__tool')));
  assert.ok(sent.some((m) => m.blocks.some((b) => b.type === 'tool_result' && b.toolUseId === 'tu_old')));
  h.close();
});
