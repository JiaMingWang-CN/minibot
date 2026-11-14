// 审查发现的 12 个问题的回归测试（2026-11-08）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths } from '../src/paths.ts';
import { openDb } from '../src/db/db.ts';
import { createThread, getThread } from '../src/db/threads.ts';
import { appendMessage, messagesFrom } from '../src/db/messages.ts';
import { newBot, saveBot, loadBot } from '../src/config/config.ts';
import { MemoryRevisions } from '../src/memory/revisions.ts';
import { Consolidator } from '../src/memory/consolidate.ts';
import { SecretSet, REDACTED } from '../src/secrets/redact.ts';
import { SecretStore, type KeyCrypto } from '../src/secrets/store.ts';
import { ReadTracker } from '../src/tools/read-tracker.ts';
import { ApprovalBroker } from '../src/approval/broker.ts';
import { editFile, readFile } from '../src/tools/files.ts';
import { executeTool, type ToolEnv } from '../src/tools/registry.ts';
import { isInside } from '../src/tools/path-guard.ts';
import { runProcess } from '../src/tools/process.ts';
import { runCommand } from '../src/tools/run-command.ts';
import { runTurn, type TurnDeps } from '../src/agent/loop.ts';
import { compactThread, makePrepareContext } from '../src/agent/compaction.ts';
import { Kernel } from '../src/kernel.ts';
import type { CallModel } from '../src/model/client.ts';
import type { ModelRequest } from '../src/model/adapter.ts';
import type { Block, StoredMessage } from '../src/model/types.ts';
import type { KernelEvent } from '../src/events.ts';

const isWin = process.platform === 'win32';

async function tmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `minibot-fix-${prefix}-`));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fakeCrypto(): KeyCrypto {
  return {
    backend: () => 'os',
    encrypt: (plain) => Buffer.concat([Buffer.from('enc:'), Buffer.from(Buffer.from(plain).toString('base64'))]),
    decrypt: (buf) => {
      const text = buf.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('无法解密');
      return Buffer.from(text.slice(4), 'base64').toString('utf8');
    },
  };
}

function textReply(text: string): Awaited<ReturnType<CallModel>> {
  return { blocks: [{ type: 'text', text }], stopReason: 'end', usage: { inputTokens: 0, outputTokens: 0 } };
}

function toolReply(name: string, input: Record<string, unknown>): Awaited<ReturnType<CallModel>> {
  return {
    blocks: [{ type: 'tool_use', id: `tu_${Math.random().toString(36).slice(2, 10)}`, name, input }],
    stopReason: 'tool_use',
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function lastText(messages: StoredMessage[]): string {
  const last = messages[messages.length - 1]!;
  return last.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

async function memorySetup() {
  const root = await tmp('files');
  const paths = dataPaths(root);
  await fs.mkdir(paths.memoryDir('b1'), { recursive: true });
  const db = openDb(paths.db);
  const ctx = {
    tracker: new ReadTracker(),
    secrets: new SecretSet(),
    revisions: new MemoryRevisions(db, paths),
    paths,
    actor: 'b1',
  };
  return { root, paths, db, ctx };
}

// 1
test('edit_file：new_string 里的 $\' $$ $& 按字面写入', async () => {
  const { root, db, ctx } = await memorySetup();
  const file = path.join(root, 'a.sh');
  await fs.writeFile(file, 'echo A\nX\necho B\n');
  await readFile(ctx, file, {});
  const result = await editFile(ctx, file, { old_string: 'X', new_string: "printf $'\\n' $$ $&" });
  assert.equal(result.isError, false);
  assert.equal(await fs.readFile(file, 'utf8'), "echo A\nprintf $'\\n' $$ $&\necho B\n");
  db.close();
});

// 2
test('runTurn：解析模型时抛出的异常转成提示，不静默失败', async () => {
  const root = await tmp('loop');
  const paths = dataPaths(root);
  await fs.mkdir(paths.defaultWorkspace('b1'), { recursive: true });
  const db = openDb(paths.db);
  const bot = newBot('b1', 'p1', 'm');
  const thread = createThread(db, 'b1', 't');
  const events: KernelEvent[] = [];
  const controller = new AbortController();
  const env: ToolEnv = {
    bot,
    threadId: thread.id,
    workspace: paths.defaultWorkspace('b1'),
    paths,
    home: root,
    tracker: new ReadTracker(),
    secrets: new SecretSet(),
    revisions: new MemoryRevisions(db, paths),
    broker: new ApprovalBroker(() => {}),
    signal: controller.signal,
  };
  const deps: TurnDeps = {
    db,
    callModel: async () => textReply('不应被调用'),
    emit: (e) => events.push(e),
    resolveModel: () => {
      throw new Error('该供应商没有可用的 API Key');
    },
    makeToolEnv: () => env,
    prepareContext: async (id) => messagesFrom(db, id, 0),
  };
  await runTurn(deps, bot, thread.id, '在吗', controller.signal);
  const messages = messagesFrom(db, thread.id, 0);
  assert.equal(messages[messages.length - 1]!.kind, 'notice');
  assert.ok(lastText(messages).includes('该供应商没有可用的 API Key'));
  assert.equal(events.some((e) => e.type === 'turn' && e.state === 'idle'), true);
  db.close();
});

// 3（压缩）+ 10 + 11
async function compactionSetup(contextWindow: number) {
  const root = await tmp('compact');
  const paths = dataPaths(root);
  const db = openDb(paths.db);
  const bot = newBot('b1', 'p1', 'm');
  bot.contextWindow = contextWindow;
  const thread = createThread(db, 'b1', 't');
  const calls: ModelRequest[] = [];
  const deps = {
    db,
    callModel: (async (a) => {
      calls.push(a.request);
      return textReply('摘要内容');
    }) as CallModel,
    resolveModel: () => ({
      provider: { id: 'p1', name: 'p', format: 'anthropic_messages' as const, baseUrl: 'http://x' },
      apiKey: 'sk-test-secret-123',
    }),
    emit: () => {},
  };
  const add = (role: 'user' | 'assistant', blocks: Block[]): StoredMessage =>
    appendMessage(db, { threadId: thread.id, role, blocks, kind: null, interrupted: false });
  return { db, bot, threadId: thread.id, deps, calls, add };
}

test('压缩摘要请求：历史拼成一条 user 文本消息，不含工具块', async () => {
  const h = await compactionSetup(1000);
  h.add('user', [{ type: 'text', text: '第一轮' }]);
  h.add('assistant', [{ type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } }]);
  h.add('user', [{ type: 'tool_result', toolUseId: 'tu_1', content: '文件内容', status: 'ok' }]);
  h.add('assistant', [{ type: 'text', text: 'a'.repeat(1000) }]);
  h.add('user', [{ type: 'text', text: '第二轮' }]);
  await compactThread(h.deps, h.bot, h.threadId, 'auto', new AbortController().signal);
  assert.equal(h.calls.length, 1);
  const request = h.calls[0]!;
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0]!.role, 'user');
  assert.ok(request.messages[0]!.blocks.every((b) => b.type === 'text'));
  const body = (request.messages[0]!.blocks[0] as { text: string }).text;
  assert.ok(body.includes('read_file'));
  assert.ok(body.includes('文件内容'));
  h.db.close();
});

test('没有可压缩的内容时不追加摘要消息', async () => {
  const h = await compactionSetup(1_000_000);
  h.add('user', [{ type: 'text', text: '只有一条' }]);
  await compactThread(h.deps, h.bot, h.threadId, 'auto', new AbortController().signal);
  assert.equal(h.calls.length, 0);
  assert.equal(getThread(h.db, h.threadId)!.summaryMsgId, null);
  assert.equal(messagesFrom(h.db, h.threadId, 0).length, 1);
  h.db.close();
});

test('无基准时估算计入系统提示词', async () => {
  const small = await compactionSetup(1000);
  small.add('user', [{ type: 'text', text: '旧' }]);
  small.add('assistant', [{ type: 'text', text: '答' }]);
  const start = small.add('user', [{ type: 'text', text: '新' }]);
  const prepareSmall = makePrepareContext(small.deps, () => {});
  await prepareSmall(small.threadId, small.bot, new AbortController().signal, start.id, '');
  assert.equal(small.calls.length, 0);

  const big = await compactionSetup(1000);
  big.add('user', [{ type: 'text', text: '旧' }]);
  big.add('assistant', [{ type: 'text', text: '答' }]);
  const start2 = big.add('user', [{ type: 'text', text: '新' }]);
  const prepareBig = makePrepareContext(big.deps, () => {});
  await prepareBig(big.threadId, big.bot, new AbortController().signal, start2.id, 's'.repeat(5000));
  assert.ok(big.calls.length >= 1);
  small.db.close();
  big.db.close();
});

// 3（后台整理）
test('后台整理请求：增量拼成一条 user 文本消息', async () => {
  const root = await tmp('consolidate');
  const paths = dataPaths(root);
  await fs.mkdir(paths.memoryDir('b1'), { recursive: true });
  const db = openDb(paths.db);
  await saveBot(paths, newBot('b1', 'p1', 'm'));
  const thread = createThread(db, 'b1', 't');
  appendMessage(db, {
    threadId: thread.id,
    role: 'assistant',
    blocks: [{ type: 'tool_use', id: 'tu_9', name: 'glob', input: { pattern: '*' } }],
    kind: null,
    interrupted: false,
  });
  appendMessage(db, {
    threadId: thread.id,
    role: 'user',
    blocks: [{ type: 'tool_result', toolUseId: 'tu_9', content: 'a.txt', status: 'ok' }],
    kind: null,
    interrupted: false,
  });
  appendMessage(db, {
    threadId: thread.id,
    role: 'assistant',
    blocks: [{ type: 'text', text: '找到了' }],
    kind: null,
    interrupted: false,
  });
  const calls: ModelRequest[] = [];
  const consolidator = new Consolidator({
    db,
    paths,
    revisions: new MemoryRevisions(db, paths),
    secrets: new SecretSet(),
    callModel: async (a) => {
      calls.push(a.request);
      return textReply('{"user": null, "topics": []}');
    },
    resolveConsolidationModel: (b) => ({
      provider: { id: 'p1', name: 'p', format: 'chat_completions', baseUrl: 'http://x' },
      apiKey: 'sk-test-secret-123',
      model: b.model,
    }),
    loadBot: (id) => loadBot(paths, id),
    isThreadRunning: () => false,
    emit: () => {},
  });
  await consolidator.consolidateThread(thread.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.messages.length, 1);
  assert.equal(calls[0]!.messages[0]!.role, 'user');
  assert.ok(calls[0]!.messages[0]!.blocks.every((b) => b.type === 'text'));
  const body = (calls[0]!.messages[0]!.blocks[0] as { text: string }).text;
  assert.ok(body.includes('glob') && body.includes('a.txt') && body.includes('找到了'));
  db.close();
});

// 4
test('runProcess：输出超过上限时只保留头尾，记录丢弃字节数', async () => {
  const root = await tmp('proc');
  const script = "process.stdout.write('a'.repeat(3000) + 'b'.repeat(3000) + 'c'.repeat(200))";
  const result = await runProcess({
    file: process.execPath,
    args: ['-e', script],
    cwd: root,
    timeoutMs: 20_000,
    signal: new AbortController().signal,
    maxOutputBytes: 1000,
    tailBytes: 200,
  });
  assert.equal(result.output.length, 1000);
  assert.equal(result.output.toString(), 'a'.repeat(1000));
  assert.equal(result.tail.toString(), 'c'.repeat(200));
  assert.equal(result.droppedBytes, 6200 - 1200);
});

// 6
test('run_command：完整输出文件经过脱敏，且清理 7 天前的旧输出', async () => {
  const root = await tmp('cmd');
  const outputsDir = path.join(root, 'outputs');
  await fs.mkdir(outputsDir, { recursive: true });
  const old = path.join(outputsDir, 'output-old.txt');
  await fs.writeFile(old, 'old');
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  await fs.utimes(old, eightDaysAgo, eightDaysAgo);
  const secrets = new SecretSet();
  secrets.add('sk-cmd-secret-123');
  const command = isWin
    ? "[Console]::Out.Write(('x' * 40000) + 'sk-cmd-secret-123')"
    : "head -c 40000 /dev/zero | tr '\\0' x; printf sk-cmd-secret-123";
  const result = await runCommand(
    { cwd: root, outputsDir, signal: new AbortController().signal, redact: (s) => secrets.redact(s) },
    { command },
  );
  assert.equal(result.isError, false);
  const files = await fs.readdir(outputsDir);
  assert.deepEqual(files.includes('output-old.txt'), false);
  assert.equal(files.length, 1);
  const full = await fs.readFile(path.join(outputsDir, files[0]!), 'utf8');
  assert.equal(full.includes('sk-cmd-secret-123'), false);
  assert.ok(full.endsWith(REDACTED));
});

// 7
test('secrets.bin 无法解密：不抛错，标记为不可读；再次保存时先备份旧文件', async () => {
  const dir = await tmp('secrets');
  const file = path.join(dir, 'secrets.bin');
  await fs.writeFile(file, 'garbage');
  const store = new SecretStore(file, fakeCrypto(), new SecretSet());
  await store.load();
  assert.equal(store.isUnreadable(), true);
  await store.set('p1', 'sk-new-secret-123');
  assert.equal(store.isUnreadable(), false);
  const names = await fs.readdir(dir);
  assert.equal(names.some((n) => n.startsWith('secrets.bin.unreadable-')), true);
  assert.equal(store.get('p1'), 'sk-new-secret-123');
});

test('Kernel：secrets.bin 无法解密时仍能打开，state 标出 secretsUnreadable', async () => {
  const root = await tmp('kernel-secrets');
  await fs.writeFile(path.join(root, 'secrets.bin'), 'garbage');
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: async () => textReply('x') });
  assert.equal((await kernel.state()).secretsUnreadable, true);
  await kernel.close();
});

// 8 + 5
async function kernelWithBot(callModel: CallModel, envName?: string) {
  const root = await tmp('kernel');
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel });
  const provider = await kernel.addProvider({
    name: 'P',
    format: 'chat_completions',
    baseUrl: 'http://x',
    apiKey: 'sk-main-secret-123',
  });
  if (envName !== undefined) {
    await kernel.addProvider({ name: 'Other', format: 'chat_completions', baseUrl: 'http://y', apiKeyEnv: envName });
  }
  const bot = await kernel.completeOnboarding({ providerId: provider.id, model: 'm' });
  await kernel.updateBot(bot.id, { approvalMode: 'auto' });
  return { root, kernel, bot };
}

test('其他供应商的环境变量 Key：启动即加入脱敏集合，且不传给子进程', async () => {
  const envName = 'MINIBOT_TEST_OTHER_KEY';
  process.env[envName] = 'sk-other-env-secret-123';
  try {
    const first = await kernelWithBot(async () => textReply('x'), envName);
    await first.kernel.close();
    let step = 0;
    const model: CallModel = async () => {
      step += 1;
      if (step === 1) {
        return toolReply('run_command', {
          command: isWin ? `Write-Output "v=$env:${envName}"` : `echo "v=$${envName}"`,
        });
      }
      return textReply('模型复述 sk-other-env-secret-123');
    };
    const kernel = await Kernel.open({ dataRoot: first.root, crypto: fakeCrypto(), callModel: model });
    const thread = kernel.createThread(first.bot.id);
    const events: KernelEvent[] = [];
    kernel.on((e) => events.push(e));
    kernel.sendMessage(thread.id, '打印变量');
    await waitFor(() => events.some((e) => e.type === 'turn' && e.state === 'idle'), 20_000);
    const all = JSON.stringify(kernel.listMessages(thread.id, undefined, 100));
    assert.equal(all.includes('sk-other-env-secret-123'), false);
    const toolResult = kernel
      .listMessages(thread.id, undefined, 100)
      .flatMap((m) => m.blocks)
      .find((b): b is Extract<Block, { type: 'tool_result' }> => b.type === 'tool_result');
    assert.ok(toolResult !== undefined && toolResult.content.includes('v='));
    assert.equal(toolResult.content.includes(REDACTED), false);
    await kernel.close();
  } finally {
    delete process.env[envName];
  }
});

test('手动压缩经过线程队列：等正在进行的一轮结束后才开始', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: ModelRequest[] = [];
  let turnCalls = 0;
  const model: CallModel = async (a) => {
    requests.push(a.request);
    if (a.request.tools.length > 0) {
      turnCalls += 1;
      if (turnCalls === 2) await gate;
      return textReply(`回复${turnCalls}`);
    }
    return textReply('摘要');
  };
  const { kernel, bot } = await kernelWithBot(model);
  const thread = kernel.createThread(bot.id);
  const events: KernelEvent[] = [];
  kernel.on((e) => events.push(e));
  kernel.sendMessage(thread.id, '第一轮');
  await waitFor(() => events.filter((e) => e.type === 'turn' && e.state === 'idle').length === 1);
  kernel.sendMessage(thread.id, '第二轮');
  await waitFor(() => turnCalls === 2);
  // 调小窗口，让 auto 边界能切出可压缩的旧消息（压缩任务运行时才读取 bot 配置）
  await kernel.updateBot(bot.id, { contextWindow: 10 });
  kernel.compact(thread.id);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(requests.filter((r) => r.tools.length === 0).length, 0);
  release?.();
  await waitFor(() => kernel.listMessages(thread.id, undefined, 100).some((m) => m.kind === 'summary'));
  const messages = kernel.listMessages(thread.id, undefined, 100);
  const summary = messages.find((m) => m.kind === 'summary')!;
  const reply2 = messages.find((m) => m.role === 'assistant' && JSON.stringify(m.blocks).includes('回复2'))!;
  assert.ok(summary.id > reply2.id);
  await kernel.close();
});

// 9
test('工作目录经由链接给出时，目录内的读取不需要审批', async () => {
  const root = await tmp('link');
  // 工作目录在数据目录之外（数据目录内除默认工作区外一律敏感）
  const paths = dataPaths(path.join(root, 'data'));
  await fs.mkdir(paths.root, { recursive: true });
  const realWs = path.join(root, 'real-ws');
  await fs.mkdir(realWs, { recursive: true });
  await fs.writeFile(path.join(realWs, 'a.txt'), 'hello');
  const linkWs = path.join(root, 'link-ws');
  await fs.symlink(realWs, linkWs, isWin ? 'junction' : 'dir');
  const db = openDb(paths.db);
  const bot = newBot('b1', 'p1', 'm');
  bot.approvalMode = 'ask';
  const broker = new ApprovalBroker(() => {});
  const env: ToolEnv = {
    bot,
    threadId: 't',
    workspace: linkWs,
    paths,
    home: path.join(root, 'home'),
    tracker: new ReadTracker(),
    secrets: new SecretSet(),
    revisions: new MemoryRevisions(db, paths),
    broker,
    signal: new AbortController().signal,
  };
  const result = await Promise.race([
    executeTool({ type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } }, env),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
  ]);
  assert.notEqual(result, null, '读取被挂起等待审批');
  assert.equal(result!.status, 'ok');
  assert.equal(broker.pending().length, 0);
  db.close();
});

test('数据目录经由链接给出时，config.json 仍按敏感路径审批', async () => {
  const base = await tmp('datalink');
  const realRoot = path.join(base, 'real-data');
  await fs.mkdir(realRoot, { recursive: true });
  const linkRoot = path.join(base, 'link-data');
  await fs.symlink(realRoot, linkRoot, isWin ? 'junction' : 'dir');
  let step = 0;
  const model: CallModel = async () => {
    step += 1;
    if (step === 1) return toolReply('read_file', { path: path.join(realRoot, 'config.json') });
    return textReply('完成');
  };
  const kernel = await Kernel.open({ dataRoot: linkRoot, crypto: fakeCrypto(), callModel: model });
  const provider = await kernel.addProvider({ name: 'P', format: 'chat_completions', baseUrl: 'http://x', apiKey: 'sk-link-secret-123' });
  const bot = await kernel.completeOnboarding({ providerId: provider.id, model: 'm' });
  await kernel.updateBot(bot.id, { approvalMode: 'auto' });
  const thread = kernel.createThread(bot.id);
  const events: KernelEvent[] = [];
  kernel.on((e) => events.push(e));
  kernel.sendMessage(thread.id, '读配置');
  await waitFor(() => events.some((e) => e.type === 'approval_request'));
  const request = events.find((e) => e.type === 'approval_request') as Extract<KernelEvent, { type: 'approval_request' }>;
  kernel.respondApproval(request.request.id, false);
  await waitFor(() => events.some((e) => e.type === 'turn' && e.state === 'idle'));
  await kernel.close();
});

// 12
test('isInside：父目录为根目录', () => {
  assert.equal(isInside('/a', '/', 'linux'), true);
  assert.equal(isInside('/', '/', 'linux'), true);
  assert.equal(isInside('C:\\a', 'C:\\', 'win32'), true);
});
