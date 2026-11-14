// 第 4 批代码审查问题（agent / memory / db / config / model / diag / kernel）的回归测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths } from '../src/paths.ts';
import { newBot, loadConfigState, loadBot, saveBot } from '../src/config/config.ts';
import { openDb } from '../src/db/db.ts';
import { createThread } from '../src/db/threads.ts';
import { appendMessage } from '../src/db/messages.ts';
import { MemoryRevisions } from '../src/memory/revisions.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import { ReadTracker } from '../src/tools/read-tracker.ts';
import { ApprovalBroker } from '../src/approval/broker.ts';
import { executeTool, type ToolEnv } from '../src/tools/registry.ts';
import { INVALID_ARGS_KEY, historyForModel } from '../src/model/adapter.ts';
import { anthropicAdapter } from '../src/model/anthropic.ts';
import { chatCompletionsAdapter } from '../src/model/chat-completions.ts';
import { ResultAccumulator } from '../src/model/accumulator.ts';
import { fitSummaryInput, compactThread } from '../src/agent/compaction.ts';
import { DiagLog } from '../src/diag/log.ts';
import { DiagnosticUploader } from '../src/diag/uploader.ts';
import { Consolidator, type ConsolidatorDeps } from '../src/memory/consolidate.ts';
import { KernelError } from '../src/kernel.ts';
import type { Block, StoredMessage } from '../src/model/types.ts';
import type { ModelRequest } from '../src/model/adapter.ts';
import type { CallModel } from '../src/model/client.ts';
import { kernelHarness, waitFor, waitIdle } from './kernel-harness.ts';

async function tmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `minibot-b4-${prefix}-`));
}

function msg(id: number, role: 'user' | 'assistant', blocks: Block[], kind: StoredMessage['kind'] = null): StoredMessage {
  return { id, threadId: 't', role, blocks, kind, interrupted: false, createdAt: 0 };
}

// ---- 工具参数解析失败 ----

test('工具参数解析失败：最终结果保留该 tool_use，执行时回错误结果让模型重试', async () => {
  const acc = new ResultAccumulator(() => {});
  acc.toolStart('0', 'read_file');
  acc.toolArgs('0', '{"path": "a.txt"');
  const [block] = acc.result().blocks;
  assert.equal(block?.type, 'tool_use');
  const input = (block as Extract<Block, { type: 'tool_use' }>).input;
  assert.equal(typeof input, 'object');
  assert.ok(INVALID_ARGS_KEY in input);

  const root = await tmp('args');
  const paths = dataPaths(root);
  const bot = newBot('b1');
  await fs.mkdir(paths.defaultWorkspace('b1'), { recursive: true });
  const db = openDb(paths.db);
  try {
    const env: ToolEnv = {
      bot,
      threadId: 't1',
      workspace: paths.defaultWorkspace('b1'),
      paths,
      home: root,
      tracker: new ReadTracker(),
      secrets: new SecretSet(),
      revisions: new MemoryRevisions(db, paths),
      broker: new ApprovalBroker(() => {}),
      signal: new AbortController().signal,
    };
    const result = await executeTool(block as Extract<Block, { type: 'tool_use' }>, env);
    assert.equal(result.status, 'error');
    assert.match(result.content, /参数/);
    assert.equal(result.toolUseId, (block as Extract<Block, { type: 'tool_use' }>).id);
  } finally {
    db.close();
  }
});

test('无法解析参数的 tool_use 回放历史时 input 仍是对象（三种适配器）', () => {
  const messages = [
    msg(1, 'user', [{ type: 'text', text: 'hi' }]),
    msg(2, 'assistant', [{ type: 'tool_use', id: 'tu_1', name: 'read_file', input: { [INVALID_ARGS_KEY]: '{"pa' } }]),
    msg(3, 'user', [{ type: 'tool_result', toolUseId: 'tu_1', content: '参数错误', status: 'error' }]),
  ];
  const req: ModelRequest = { model: 'm', system: 's', messages, tools: [], maxTokens: 10, thinkingLevel: null };
  const anthropic = JSON.stringify(anthropicAdapter.body(req));
  assert.match(anthropic, /"input":\{/);
  const chat = JSON.stringify(chatCompletionsAdapter.body(req));
  assert.match(chat, /"arguments":"\{/);
});

// ---- 悬空 tool_use 兜底 ----

test('historyForModel：缺结果的 tool_use 补一条已取消的结果（末尾、中间、部分缺失）', () => {
  const tail = historyForModel([
    msg(1, 'user', [{ type: 'text', text: 'hi' }]),
    msg(2, 'assistant', [{ type: 'tool_use', id: 'a', name: 'x', input: {} }]),
  ]);
  assert.equal(tail.length, 3);
  assert.deepEqual(
    tail[2]!.blocks.map((b) => (b.type === 'tool_result' ? [b.toolUseId, b.status] : null)),
    [['a', 'cancelled']],
  );

  const partial = historyForModel([
    msg(1, 'user', [{ type: 'text', text: 'hi' }]),
    msg(2, 'assistant', [
      { type: 'tool_use', id: 'a', name: 'x', input: {} },
      { type: 'tool_use', id: 'b', name: 'x', input: {} },
    ]),
    msg(3, 'user', [{ type: 'tool_result', toolUseId: 'a', content: 'ok', status: 'ok' }]),
    msg(4, 'user', [{ type: 'text', text: '继续' }]),
  ]);
  const ids = partial.flatMap((m) => m.blocks.flatMap((b) => (b.type === 'tool_result' ? [b.toolUseId] : [])));
  assert.deepEqual(ids.sort(), ['a', 'b']);

  // 完整的历史不变
  const full = [
    msg(1, 'user', [{ type: 'text', text: 'hi' }]),
    msg(2, 'assistant', [{ type: 'tool_use', id: 'a', name: 'x', input: {} }]),
    msg(3, 'user', [{ type: 'tool_result', toolUseId: 'a', content: 'ok', status: 'ok' }]),
  ];
  assert.equal(historyForModel(full).length, 3);
});

test('Anthropic 请求：悬空 tool_use 之后紧跟 tool_result', () => {
  const body = anthropicAdapter.body({
    model: 'm',
    system: 's',
    messages: [
      msg(1, 'user', [{ type: 'text', text: 'hi' }]),
      msg(2, 'assistant', [{ type: 'tool_use', id: 'a', name: 'x', input: {} }]),
      msg(3, 'user', [{ type: 'text', text: '继续' }]),
    ],
    tools: [],
    maxTokens: 10,
    thinkingLevel: null,
  }) as { messages: { role: string; content: { type: string }[] }[] };
  const user = body.messages[2]!;
  assert.equal(user.role, 'user');
  assert.equal(user.content[0]!.type, 'tool_result');
});

// ---- Anthropic 空 system ----

test('Anthropic：system 为空时不发送 system 字段', () => {
  const base = { model: 'm', messages: [msg(1, 'user', [{ type: 'text', text: 'ping' }])], tools: [], maxTokens: 1, thinkingLevel: null };
  const empty = anthropicAdapter.body({ ...base, system: '' }) as Record<string, unknown>;
  assert.equal('system' in empty, false);
  const filled = anthropicAdapter.body({ ...base, system: 'hello' }) as { system: { text: string }[] };
  assert.equal(filled.system[0]!.text, 'hello');
});

// ---- 审批模式读最新配置 ----

test('审批模式：工具调用前读最新模式，本轮中途改动立即生效', async () => {
  const root = await tmp('approval');
  const paths = dataPaths(root);
  const bot = newBot('b1');
  await fs.mkdir(paths.defaultWorkspace('b1'), { recursive: true });
  const db = openDb(paths.db);
  try {
    let mode: 'ask' | 'auto' = 'auto';
    const broker = new ApprovalBroker(() => {});
    const env: ToolEnv = {
      bot: { ...bot, approvalMode: 'auto' },
      threadId: 't1',
      workspace: paths.defaultWorkspace('b1'),
      paths,
      home: root,
      tracker: new ReadTracker(),
      secrets: new SecretSet(),
      revisions: new MemoryRevisions(db, paths),
      broker,
      signal: new AbortController().signal,
      approvalMode: async () => mode,
    };
    const write = (id: string, name: string) =>
      executeTool({ type: 'tool_use', id, name: 'write_file', input: { path: path.join(env.workspace, name), content: 'x' } }, env);
    assert.equal((await write('1', 'a.txt')).status, 'ok');
    assert.equal(broker.pending().length, 0);
    mode = 'ask';
    const pending = write('2', 'b.txt');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(broker.pending().length, 1);
    broker.respond(broker.pending()[0]!.id, false);
    assert.equal((await pending).status, 'denied');
  } finally {
    db.close();
  }
});

// ---- 压缩摘要输入不超窗 ----

test('fitSummaryInput：待摘要内容超预算时丢掉最早的，保留开头的旧摘要和最近的内容', () => {
  const big = 'x'.repeat(2000);
  const messages = [
    msg(1, 'user', [{ type: 'text', text: '旧摘要' }], 'summary'),
    msg(2, 'user', [{ type: 'text', text: big }]),
    msg(3, 'assistant', [{ type: 'text', text: big }]),
    msg(4, 'user', [{ type: 'text', text: big }]),
  ];
  const fitted = fitSummaryInput(messages, 1000);
  assert.equal(fitted[0]!.id, 1);
  assert.equal(fitted.at(-1)!.id, 4);
  assert.ok(fitted.length < messages.length);
  assert.equal(fitSummaryInput(messages, 1_000_000).length, 4);
});

test('compactThread：待压缩历史远超窗口时摘要请求也被裁到窗口内', async () => {
  const root = await tmp('compact');
  const paths = dataPaths(root);
  const db = openDb(paths.db);
  try {
    const bot = newBot('b1', 'p1', 'm');
    bot.contextWindow = 2000;
    const thread = createThread(db, 'b1', 't');
    const add = (role: 'user' | 'assistant', text: string): void => {
      appendMessage(db, { threadId: thread.id, role, blocks: [{ type: 'text', text }], kind: null, interrupted: false });
    };
    for (let i = 0; i < 20; i += 1) {
      add('user', `问题${i} ${'y'.repeat(1500)}`);
      add('assistant', `回答${i} ${'z'.repeat(1500)}`);
    }
    add('user', '最后一问');
    const sizes: number[] = [];
    await compactThread(
      {
        db,
        callModel: async (a) => {
          const first = a.request.messages[0]!.blocks[0] as { text: string };
          sizes.push(first.text.length);
          return { blocks: [{ type: 'text', text: '摘要' }], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } };
        },
        resolveModel: () => ({
          provider: { id: 'p1', name: 'p', format: 'chat_completions', baseUrl: 'http://x' },
          apiKey: 'k',
        }),
        emit: () => {},
      },
      bot,
      thread.id,
      'auto',
      new AbortController().signal,
    );
    assert.equal(sizes.length, 1);
    // 窗口 2000 token：约 0.7×2000×3.5 ≈ 4900 个英文字符，远小于全部历史（60000+）
    assert.ok(sizes[0]! < 8000, `摘要输入过长：${sizes[0]}`);
  } finally {
    db.close();
  }
});

// ---- config.json 损坏 ----

test('config.json 损坏：备份为 .bad 后用默认配置启动；schemaVersion 不符仍拒绝启动', async () => {
  const root = await tmp('cfg');
  const paths = dataPaths(root);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(paths.config, '{ not json');
  const loaded = await loadConfigState(paths);
  assert.deepEqual(loaded.config.providers, []);
  assert.equal(await fs.readFile(`${paths.config}.bad`, 'utf8'), '{ not json');

  await fs.writeFile(paths.config, JSON.stringify([1, 2]));
  assert.deepEqual((await loadConfigState(paths)).config.providers, []);

  const future = JSON.stringify({ schemaVersion: 2, providers: [] });
  await fs.writeFile(paths.config, future);
  await assert.rejects(loadConfigState(paths), /schemaVersion/);
  assert.equal(await fs.readFile(paths.config, 'utf8'), future);
});

test('config.json 里单个 provider 条目非法：跳过该条，其余保留', async () => {
  const root = await tmp('cfgp');
  const paths = dataPaths(root);
  await fs.mkdir(root, { recursive: true });
  const good = { id: 'p1', name: 'P', format: 'chat_completions', baseUrl: 'http://x' };
  await fs.writeFile(
    paths.config,
    JSON.stringify({ schemaVersion: 1, providers: [good, { id: 'p2' }, 'oops'], mainBotId: null, consolidationModel: null }),
  );
  const { config } = await loadConfigState(paths);
  assert.deepEqual(config.providers.map((p) => p.id), ['p1']);
});

test('loadBot：bot.json 里的 id 与目录名不一致时拒绝', async () => {
  const root = await tmp('botid');
  const paths = dataPaths(root);
  await fs.mkdir(paths.botDir('b1'), { recursive: true });
  await saveBot(paths, newBot('b1'));
  assert.equal((await loadBot(paths, 'b1')).id, 'b1');
  await fs.mkdir(paths.botDir('b2'), { recursive: true });
  await fs.copyFile(paths.botJson('b1'), paths.botJson('b2'));
  await assert.rejects(loadBot(paths, 'b2'), /不一致/);
});

// ---- 诊断上传超时 ----

test('诊断上传：请求挂住时按超时中止并记失败，不卡住队列', async () => {
  const root = await tmp('upload');
  const db = openDb(path.join(root, 'minibot.db'));
  const diag = new DiagLog({ dir: path.join(root, 'logs'), secrets: new SecretSet() });
  let calls = 0;
  const fetchImpl = ((_url: unknown, init: { signal?: AbortSignal }) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }) as unknown as typeof fetch;
  const now = 1_000_000;
  const uploader = new DiagnosticUploader({
    db,
    diag,
    collectUrl: 'https://collect.test/collect',
    installId: () => 'i',
    consent: () => 'on',
    platform: 'win32',
    appVersion: '0.1.0',
    os: 'x',
    fetchImpl,
    now: () => now,
    autoStart: false,
    postTimeoutMs: 30,
  });
  try {
    uploader.start();
    for (let i = 0; i < 60; i += 1) uploader.push({ kind: 'error', name: `err.e${i}`, data: { i } });
    await Promise.race([
      uploader.tick(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('上传请求没有超时')), 3000)),
    ]);
    assert.equal(calls, 1);
  } finally {
    uploader.close();
    await diag.close();
    db.close();
  }
});

// ---- 记忆整理并发 ----

test('同一线程的整理不会并发进行（不重复调用模型）', async () => {
  const root = await tmp('consol');
  const paths = dataPaths(root);
  await fs.mkdir(paths.memoryDir('b1'), { recursive: true });
  const db = openDb(paths.db);
  try {
    const bot = newBot('b1', 'p1', 'm');
    await saveBot(paths, bot);
    const thread = createThread(db, 'b1', 't');
    appendMessage(db, { threadId: thread.id, role: 'user', blocks: [{ type: 'text', text: '我喜欢咖啡' }], kind: null, interrupted: false });
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps: ConsolidatorDeps = {
      db,
      paths,
      revisions: new MemoryRevisions(db, paths),
      secrets: new SecretSet(),
      callModel: async () => {
        calls += 1;
        await gate;
        return { blocks: [{ type: 'text', text: '{"user":null,"topics":[]}' }], stopReason: 'end', usage: { inputTokens: 0, outputTokens: 0 } };
      },
      resolveConsolidationModel: (b) => ({
        provider: { id: 'p1', name: 'p', format: 'chat_completions', baseUrl: 'http://x' },
        apiKey: 'k',
        model: b.model,
        contextWindow: b.contextWindow,
        maxOutputTokens: b.maxOutputTokens,
      }),
      loadBot: (id) => loadBot(paths, id),
      isThreadRunning: () => false,
      emit: () => {},
    };
    const consolidator = new Consolidator(deps);
    const first = consolidator.consolidateThread(thread.id);
    const second = consolidator.consolidateThread(thread.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await Promise.all([first, second]);
    assert.equal(calls, 1);
  } finally {
    db.close();
  }
});

// ---- kernel ----

test('addProvider / updateProvider：baseUrl 与字段类型校验', async () => {
  const h = await kernelHarness();
  try {
    const base = { name: 'X', format: 'chat_completions' as const };
    for (const baseUrl of ['', 'not a url', 'ftp://x/y', 123 as unknown as string]) {
      await assert.rejects(h.kernel.addProvider({ ...base, baseUrl }), (e) => e instanceof KernelError && e.code === 'invalid');
    }
    await assert.rejects(
      h.kernel.addProvider({ ...base, baseUrl: 'https://x.test', apiKeyEnv: 5 as unknown as string }),
      (e) => e instanceof KernelError && e.code === 'invalid',
    );
    const ok = await h.kernel.addProvider({ ...base, baseUrl: ' https://x.test/v1 ' });
    assert.equal(ok.baseUrl, 'https://x.test/v1');
    await assert.rejects(h.kernel.updateProvider(ok.id, { baseUrl: 'nope' }), (e) => e instanceof KernelError && e.code === 'invalid');
    await assert.rejects(
      h.kernel.updateProvider(ok.id, { name: 7 as unknown as string }),
      (e) => e instanceof KernelError && e.code === 'invalid',
    );
    assert.equal((await h.kernel.updateProvider(ok.id, { baseUrl: 'http://127.0.0.1:11434/v1' })).baseUrl, 'http://127.0.0.1:11434/v1');
  } finally {
    await h.close();
  }
});

test('addProvider：配置写盘失败时回滚内存与密钥', async () => {
  const h = await kernelHarness();
  try {
    const paths = dataPaths(h.root);
    const before = (await h.kernel.state()).providers.length;
    // 让写 config.json 失败：把它换成目录
    await fs.rm(paths.config, { force: true });
    await fs.mkdir(paths.config);
    await assert.rejects(
      h.kernel.addProvider({ name: 'Y', format: 'chat_completions', baseUrl: 'https://y.test', apiKey: 'sk-rollback-secret-123' }),
    );
    assert.equal((await h.kernel.state()).providers.length, before);
  } finally {
    await h.close();
  }
});

test('completeOnboarding：校验 model / contextWindow / workspace；并发只建一个主 bot', async () => {
  const root = await tmp('onboard');
  const { Kernel } = await import('../src/kernel.ts');
  const { fakeCrypto, textModel } = await import('./kernel-harness.ts');
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: textModel() });
  try {
    const provider = await kernel.addProvider({ name: 'P', format: 'chat_completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-onboard-secret-123' });
    const invalid = (e: unknown): boolean => e instanceof KernelError && e.code === 'invalid';
    await assert.rejects(kernel.completeOnboarding({ providerId: provider.id, model: '' }), invalid);
    await assert.rejects(kernel.completeOnboarding({ providerId: provider.id, model: 'm', contextWindow: -1 }), invalid);
    await assert.rejects(kernel.completeOnboarding({ providerId: provider.id, model: 'm', workspace: 'relative/dir' }), invalid);
    const results = await Promise.allSettled([
      kernel.completeOnboarding({ providerId: provider.id, model: 'm' }),
      kernel.completeOnboarding({ providerId: provider.id, model: 'm' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await kernel.state()).bots.length, 1);
  } finally {
    await kernel.close();
  }
});

test('updateBot：名称与模型不能为空；updateSettings 校验整理模型格式', async () => {
  const h = await kernelHarness();
  try {
    const invalid = (e: unknown): boolean => e instanceof KernelError && e.code === 'invalid';
    await assert.rejects(h.kernel.updateBot(h.bot.id, { name: '  ' }), invalid);
    await assert.rejects(h.kernel.updateBot(h.bot.id, { model: '' }), invalid);
    const providerId = h.bot.providerId;
    await assert.rejects(h.kernel.updateSettings({ consolidationModel: { providerId, model: 5 } as never }), invalid);
    await assert.rejects(h.kernel.updateSettings({ consolidationModel: { providerId, model: '' } }), invalid);
    await h.kernel.updateSettings({ consolidationModel: { providerId, model: 'm2' } });
  } finally {
    await h.close();
  }
});

test('发消息时读不到 bot：对话里留一条提示，不是静默失败', async () => {
  const h = await kernelHarness();
  try {
    await fs.rm(dataPaths(h.root).botJson(h.bot.id));
    h.kernel.sendMessage(h.threadId, '你好');
    await waitFor(() =>
      h.events.some(
        (e) => e.type === 'message' && e.message.kind === 'notice' && JSON.stringify(e.message.blocks).includes('消息未能发送'),
      ),
    );
  } finally {
    await h.close();
  }
});

test('删除线程：排队中的插话带的图片附件一并清掉', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model: CallModel = async ({ signal }) => {
    await Promise.race([
      gate,
      new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve())),
    ]);
    return { blocks: [{ type: 'text', text: 'ok' }], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const h = await kernelHarness(model);
  try {
    assert.equal(h.kernel.sendMessage(h.threadId, '开始'), 'turn');
    await waitFor(() => h.events.some((e) => e.type === 'turn' && e.state === 'running'));
    const png = Buffer.from('fake').toString('base64');
    assert.equal(h.kernel.sendMessage(h.threadId, '插话', [{ mediaType: 'image/png', data: png }]), 'steer');
    const attachments = dataPaths(h.root).attachments;
    assert.equal((await fs.readdir(attachments)).length, 1);
    await h.kernel.deleteThread(h.threadId);
    release();
    assert.deepEqual(await fs.readdir(attachments), []);
  } finally {
    release();
    await h.close();
  }
});

test('审批模式中途改回 ask：本轮后续的工具调用立即要审批', async () => {
  let n = 0;
  const h0 = await kernelHarness();
  await h0.close();
  const workspace = await tmp('ws');
  let kernelRef: import('../src/kernel.ts').Kernel | undefined;
  let botId = '';
  const model: CallModel = async () => {
    n += 1;
    if (n === 1) {
      return {
        blocks: [{ type: 'tool_use', id: 'tu_a', name: 'write_file', input: { path: path.join(workspace, 'a.txt'), content: 'a' } }],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    if (n === 2) {
      await kernelRef!.updateBot(botId, { approvalMode: 'ask' });
      return {
        blocks: [{ type: 'tool_use', id: 'tu_b', name: 'write_file', input: { path: path.join(workspace, 'b.txt'), content: 'b' } }],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    return { blocks: [{ type: 'text', text: '完成' }], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const h = await kernelHarness(model);
  try {
    kernelRef = h.kernel;
    botId = h.bot.id;
    await h.kernel.updateBot(botId, { approvalMode: 'auto', workspace });
    h.kernel.sendMessage(h.threadId, '写两个文件');
    await waitFor(() => h.kernel.pendingApprovals().length === 1);
    assert.equal(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8'), 'a');
    await assert.rejects(fs.access(path.join(workspace, 'b.txt')));
    h.kernel.respondApproval(h.kernel.pendingApprovals()[0]!.id, false);
    await waitIdle(h);
  } finally {
    await h.close();
  }
});

test('writeMemoryFile：主题文件必须是记忆目录下一级的 .md', async () => {
  const h = await kernelHarness();
  try {
    const paths = dataPaths(h.root);
    const dir = paths.memoryDir(h.bot.id);
    await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
    const invalid = (e: unknown): boolean => e instanceof KernelError && e.code === 'invalid';
    await assert.rejects(h.kernel.writeMemoryFile(path.join(dir, 'note.txt'), 'x', ''), invalid);
    await assert.rejects(h.kernel.writeMemoryFile(path.join(dir, 'sub', 'a.md'), 'x', ''), invalid);
    const ok = await h.kernel.writeMemoryFile(path.join(dir, 'coffee.md'), '> 简介：咖啡\n喜欢', createHash('sha256').update('').digest('hex'));
    assert.ok(ok.hash.length > 0);
  } finally {
    await h.close();
  }
});
