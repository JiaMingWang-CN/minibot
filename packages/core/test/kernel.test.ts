import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths } from '../src/paths.ts';
import { openDb } from '../src/db/db.ts';
import { createThread } from '../src/db/threads.ts';
import { appendMessage } from '../src/db/messages.ts';
import { Kernel, KernelError } from '../src/kernel.ts';
import { defaultConfig, loadBot, newBot, saveBot, saveConfig } from '../src/config/config.ts';
import { kernelHarness } from './kernel-harness.ts';
import type { KernelEvent } from '../src/events.ts';
import type { KeyCrypto } from '../src/secrets/store.ts';
import { AbortedError } from '../src/model/types.ts';
import type { CallModel } from '../src/model/client.ts';
import type { Block } from '../src/model/types.ts';
import { CANCELLED_TEXT } from '../src/db/messages.ts';
import { estimateChars } from '../src/agent/compaction.ts';

function fakeCrypto(backend = 'os'): KeyCrypto {
  return {
    backend: () => backend,
    encrypt: (plain) => Buffer.concat([Buffer.from('enc:'), Buffer.from(Buffer.from(plain).toString('base64'))]),
    decrypt: (buf) => Buffer.from(buf.toString('utf8').slice(4), 'base64').toString('utf8'),
  };
}

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minibot-kernel-'));
}

function echoModel(text = '你好'): CallModel {
  return async ({ onDelta }) => {
    onDelta({ type: 'text', text });
    return {
      blocks: [{ type: 'text', text }],
      stopReason: 'end',
      usage: { inputTokens: 5, outputTokens: 1 },
    };
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('open 时执行 repairDanglingToolUses', async () => {
  const root = await tmpRoot();
  const paths = dataPaths(root);
  const db = openDb(paths.db);
  const thread = createThread(db, 'b1', 't');
  appendMessage(db, {
    threadId: thread.id,
    role: 'assistant',
    blocks: [{ type: 'tool_use', id: 'tu_dangling', name: 'read_file', input: { path: 'x' } }],
    kind: null,
    interrupted: true,
  });
  db.close();
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: echoModel() });
  const messages = kernel.listMessages(thread.id);
  const last = messages[messages.length - 1]!;
  assert.equal(last.role, 'user');
  assert.deepEqual(last.blocks, [
    { type: 'tool_result', toolUseId: 'tu_dangling', content: CANCELLED_TEXT, status: 'cancelled' },
  ]);
  await kernel.close();
});

test('onboarding：设定为空时随机生成；工作目录为空时用默认目录并创建；写入 user.md；设为主 bot；新 bot 默认 approvalMode "ask"', async () => {
  const root = await tmpRoot();
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: echoModel() });
  const provider = await kernel.addProvider({
    name: 'P',
    format: 'chat_completions',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'sk-onboard-secret-123',
  });
  const bot = await kernel.completeOnboarding({
    providerId: provider.id,
    model: 'm',
    profile: '我喜欢喝咖啡。',
  });
  assert.ok(bot.name.length > 0);
  assert.ok(bot.persona.length > 0);
  assert.equal(bot.approvalMode, 'ask');
  const paths = dataPaths(root);
  const workspace = paths.defaultWorkspace(bot.id);
  assert.equal((await fs.stat(workspace)).isDirectory(), true);
  assert.equal(await fs.readFile(paths.userMd, 'utf8'), '我喜欢喝咖啡。');
  const state = await kernel.state();
  assert.equal(state.onboarded, true);
  assert.equal(state.mainBotId, bot.id);
  assert.equal(state.bots.length, 1);
  assert.deepEqual(state.defaultWorkspaces, { [bot.id]: workspace });
  await kernel.close();
});

test('updateBot：thinkingLevel 不在 allowedThinkingLevels 中 → invalid；换供应商或模型名后原档位不再允许时重置为 null', async () => {
  const root = await tmpRoot();
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: echoModel() });
  const custom = await kernel.addProvider({
    name: '自定义',
    format: 'chat_completions',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'sk-a-123456',
    presetId: 'custom-chat',
  });
  const deepseek = await kernel.addProvider({
    name: 'DeepSeek',
    format: 'chat_completions',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-b-123456',
    presetId: 'deepseek',
  });
  const bot = await kernel.completeOnboarding({ providerId: custom.id, model: 'm' });
  const set = await kernel.updateBot(bot.id, { thinkingLevel: 'xhigh' });
  assert.equal(set.thinkingLevel, 'xhigh');

  await assert.rejects(
    kernel.updateBot(bot.id, { thinkingLevel: 'bogus' as never }),
    (err: unknown) => err instanceof KernelError && err.code === 'invalid',
  );

  const switched = await kernel.updateBot(bot.id, {
    providerId: deepseek.id,
    model: 'deepseek-v4-pro',
  });
  assert.equal(switched.thinkingLevel, null);

  await assert.rejects(
    kernel.updateBot(bot.id, { thinkingLevel: 'none' }),
    (err: unknown) => err instanceof KernelError && err.code === 'invalid',
  );
  const allowed = await kernel.updateBot(bot.id, { thinkingLevel: 'high' });
  assert.equal(allowed.thinkingLevel, 'high');
  await kernel.close();
});

test('onboarding 未给 contextWindow 时按 defaultContextWindow 填', async () => {
  const root1 = await tmpRoot();
  const k1 = await Kernel.open({ dataRoot: root1, crypto: fakeCrypto(), callModel: echoModel() });
  const deepseek = await k1.addProvider({
    name: 'DeepSeek',
    format: 'chat_completions',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-d-123456',
    presetId: 'deepseek',
  });
  const bot1 = await k1.completeOnboarding({ providerId: deepseek.id, model: 'deepseek-v4-pro' });
  assert.equal(bot1.contextWindow, 1_000_000);
  await k1.close();

  const root2 = await tmpRoot();
  const k2 = await Kernel.open({ dataRoot: root2, crypto: fakeCrypto(), callModel: echoModel() });
  const volc = await k2.addProvider({
    name: '火山',
    format: 'responses',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    apiKey: 'sk-v-123456',
    presetId: 'volc-coding',
  });
  const bot2 = await k2.completeOnboarding({
    providerId: volc.id,
    model: 'doubao-seed-2.0-mini',
  });
  assert.equal(bot2.contextWindow, 256_000);
  await k2.close();
});

test('Key 不落进 config.json；state 里 hasKey 正确', async () => {
  const root = await tmpRoot();
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: echoModel() });
  const key = 'sk-config-secret-123';
  const provider = await kernel.addProvider({
    name: 'P',
    format: 'chat_completions',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: key,
  });
  const paths = dataPaths(root);
  const configText = await fs.readFile(paths.config, 'utf8');
  assert.equal(configText.includes(key), false);
  const state = await kernel.state();
  assert.equal(state.providers[0]!.hasKey, true);
  assert.equal('apiKey' in state.providers[0]!, false);
  assert.equal(provider.id.length > 0, true);
  await kernel.close();
});

test('Linux basic_text：addProvider 带 apiKey → KernelError key_not_persistable；用 apiKeyEnv 可以', async () => {
  const root = await tmpRoot();
  const envName = 'MINIBOT_TEST_KEY_ENV';
  const previous = process.env[envName];
  process.env[envName] = 'sk-env-secret-123';
  try {
    const kernel = await Kernel.open({
      dataRoot: root,
      crypto: fakeCrypto('basic_text'),
      callModel: echoModel(),
      platform: 'linux',
    });
    assert.equal((await kernel.state()).canPersistKeys, false);
    await assert.rejects(
      kernel.addProvider({
        name: 'P',
        format: 'chat_completions',
        baseUrl: 'http://x',
        apiKey: 'sk-12345678',
      }),
      (err: unknown) => err instanceof KernelError && err.code === 'key_not_persistable',
    );
    const provider = await kernel.addProvider({
      name: 'P2',
      format: 'chat_completions',
      baseUrl: 'http://x',
      apiKeyEnv: envName,
    });
    const state = await kernel.state();
    assert.equal(state.providers[0]!.hasKey, true);
    assert.equal(state.providers[0]!.id, provider.id);
    const configText = await fs.readFile(dataPaths(root).config, 'utf8');
    assert.equal(configText.includes('sk-env-secret-123'), false);
    await kernel.close();
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});

test('updateBot：name / persona / model 必须是字符串，workspace 必须是绝对路径或 null', async () => {
  const root = await tmpRoot();
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto('keychain'), callModel: echoModel() });
  const provider = await kernel.addProvider({
    name: 'P',
    format: 'chat_completions',
    baseUrl: 'http://x',
    apiKey: 'sk-12345678',
  });
  const bot = await kernel.completeOnboarding({ providerId: provider.id, model: 'm' });
  for (const patch of [{ name: 1 }, { persona: null }, { model: {} }, { workspace: 'relative/dir' }, { workspace: 5 }]) {
    await assert.rejects(
      kernel.updateBot(bot.id, patch as never),
      (err: unknown) => err instanceof KernelError && err.code === 'invalid',
    );
  }
  assert.equal((await kernel.updateBot(bot.id, { workspace: root })).workspace, root);
  assert.equal((await kernel.updateBot(bot.id, { workspace: null })).workspace, null);
  await kernel.close();
});

test('updateProvider：apiKeyEnv 传空串清除；校验失败时不留下半截修改', async () => {
  const root = await tmpRoot();
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto('keychain'), callModel: echoModel() });
  const provider = await kernel.addProvider({
    name: 'P',
    format: 'chat_completions',
    baseUrl: 'http://x',
    apiKeyEnv: 'MINIBOT_TEST_NOT_SET_ENV',
  });
  assert.equal((await kernel.updateProvider(provider.id, { apiKeyEnv: '' })).apiKeyEnv, undefined);
  assert.equal((await kernel.state()).providers[0]!.apiKeyEnv, undefined);

  await assert.rejects(
    kernel.updateProvider(provider.id, { name: '新名字', presetId: 'no-such-preset' }),
    (err: unknown) => err instanceof KernelError && err.code === 'invalid',
  );
  assert.equal((await kernel.state()).providers[0]!.name, 'P');
  await kernel.close();
});

test('界面写记忆：baseHash 过期 → conflict；成功时记 manual_ui / user 修订', async () => {
  const root = await tmpRoot();
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: echoModel() });
  const provider = await kernel.addProvider({
    name: 'P',
    format: 'chat_completions',
    baseUrl: 'http://x',
    apiKey: 'sk-ui-secret-123',
  });
  const bot = await kernel.completeOnboarding({
    providerId: provider.id,
    model: 'm',
    profile: '旧画像',
  });
  const memory = await kernel.listMemory(bot.id);
  const opened = await kernel.readMemoryFile(memory.user.path);
  await assert.rejects(
    kernel.writeMemoryFile(memory.user.path, '新画像', 'not-the-hash'),
    (err: unknown) => err instanceof KernelError && err.code === 'conflict',
  );
  const written = await kernel.writeMemoryFile(memory.user.path, '新画像', opened.hash);
  assert.equal(written.hash.length > 0, true);
  const revisions = kernel.listRevisions(memory.user.path);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0]!.source, 'manual_ui');
  assert.equal(revisions[0]!.actor, 'user');
  const reread = await kernel.readMemoryFile(memory.user.path);
  assert.equal(reread.content, '新画像');
  await kernel.close();
});

test('readMemoryFile 拒绝非记忆路径', async () => {
  const root = await tmpRoot();
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: echoModel() });
  const paths = dataPaths(root);
  await assert.rejects(
    kernel.readMemoryFile(paths.config),
    (err: unknown) => err instanceof KernelError && err.code === 'invalid',
  );
  await kernel.close();
});

test('sendMessage 端到端（假模型）：发出 delta、message 与 turn 事件', async () => {
  const root = await tmpRoot();
  const kernel = await Kernel.open({
    dataRoot: root,
    crypto: fakeCrypto(),
    callModel: echoModel('你好呀'),
  });
  const provider = await kernel.addProvider({
    name: 'P',
    format: 'chat_completions',
    baseUrl: 'http://x',
    apiKey: 'sk-send-secret-123',
  });
  const bot = await kernel.completeOnboarding({ providerId: provider.id, model: 'm' });
  const thread = kernel.createThread(bot.id);
  const events: KernelEvent[] = [];
  kernel.on((e) => events.push(e));
  kernel.sendMessage(thread.id, '在吗');
  await waitFor(() =>
    events.some((e) => e.type === 'turn' && e.threadId === thread.id && e.state === 'idle'),
  );
  assert.equal(events.some((e) => e.type === 'delta'), true);
  const assistant = kernel.listMessages(thread.id).find((m) => m.role === 'assistant');
  const textBlock = assistant?.blocks.find(
    (b): b is Extract<Block, { type: 'text' }> => b.type === 'text',
  );
  assert.equal(textBlock?.text, '你好呀');
  assert.equal(events.some((e) => e.type === 'message' && e.message.role === 'assistant'), true);
  await kernel.close();
});

test('close 中止正在运行的线程', async () => {
  let modelSignal: AbortSignal | undefined;
  let signalReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const model: CallModel = async ({ signal }) => {
    modelSignal = signal;
    signalReady?.();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new AbortedError([{ type: 'text', text: '部分' }])), {
        once: true,
      });
    });
  };
  const root = await tmpRoot();
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: model });
  const provider = await kernel.addProvider({
    name: 'P',
    format: 'chat_completions',
    baseUrl: 'http://x',
    apiKey: 'sk-close-secret-123',
  });
  const bot = await kernel.completeOnboarding({ providerId: provider.id, model: 'm' });
  const thread = kernel.createThread(bot.id);
  kernel.sendMessage(thread.id, '开始');
  await ready;
  await kernel.close();
  assert.equal(modelSignal?.aborted, true);
});

test('deleteProvider：有 bot 在用时抛 provider_in_use', async () => {
  const root = await tmpRoot();
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: echoModel() });
  const provider = await kernel.addProvider({
    name: 'P',
    format: 'chat_completions',
    baseUrl: 'http://x',
    apiKey: 'sk-del-secret-123',
  });
  await kernel.completeOnboarding({ providerId: provider.id, model: 'm' });
  await assert.rejects(
    kernel.deleteProvider(provider.id),
    (err: unknown) => err instanceof KernelError && err.code === 'provider_in_use',
  );
  await kernel.close();
});

test('迁移只给主 bot 开联网；用户之后关掉，重启不会被改回', async () => {
  const root = await tmpRoot();
  const paths = dataPaths(root);
  await fs.mkdir(paths.botsDir, { recursive: true });
  await saveBot(paths, { ...newBot('main'), name: '主 bot' });
  await saveBot(paths, { ...newBot('other'), name: '副 bot' });
  await saveConfig(paths, { ...defaultConfig(), mainBotId: 'main' });

  const k = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: echoModel() });
  let bots = (await k.state()).bots;
  assert.equal(bots.find((b) => b.id === 'main')!.extensions.web, true);
  assert.equal(bots.find((b) => b.id === 'other')!.extensions.web, false);
  assert.equal(JSON.parse(await fs.readFile(paths.config, 'utf8')).extensionsMigrated, true);

  const off = await loadBot(paths, 'main');
  off.extensions = { ...off.extensions, web: false };
  await saveBot(paths, off);
  await k.close();
  const k2 = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: echoModel() });
  bots = (await k2.state()).bots;
  assert.equal(bots.find((b) => b.id === 'main')!.extensions.web, false);
  await k2.close();
});

test('enableForMainBot 只改主 bot；removeFromAllBots 清掉启用与 allowedMcpTools', async () => {
  const root = await tmpRoot();
  const paths = dataPaths(root);
  await fs.mkdir(paths.botsDir, { recursive: true });
  await saveBot(paths, { ...newBot('main'), name: '主 bot' });
  await saveBot(paths, { ...newBot('other'), name: '副 bot' });
  await saveConfig(paths, { ...defaultConfig(), mainBotId: 'main' });
  const k = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: echoModel() });

  await k.enableForMainBot('mcpServers', 's1');
  await k.enableForMainBot('mcpServers', 's1');
  let bots = (await k.state()).bots;
  assert.deepEqual(bots.find((b) => b.id === 'main')!.extensions.mcpServers, ['s1']);
  assert.deepEqual(bots.find((b) => b.id === 'other')!.extensions.mcpServers, []);

  for (const id of ['main', 'other']) {
    const b = await loadBot(paths, id);
    b.extensions.mcpServers = ['s1'];
    b.allowedMcpTools = ['s1/x', 's2/y'];
    await saveBot(paths, b);
  }
  await k.removeFromAllBots('mcpServers', 's1');
  bots = (await k.state()).bots;
  for (const bot of bots) {
    assert.equal(bot.extensions.mcpServers.includes('s1'), false);
    assert.equal(bot.allowedMcpTools.some((key) => key.startsWith('s1/')), false);
    assert.deepEqual(bot.allowedMcpTools, ['s2/y']);
  }

  // 卸载插件 / skill 只动对应启用列表，不碰 MCP 工具白名单，即使 id 恰好与 server id 相同
  const main = await loadBot(paths, 'main');
  main.extensions.plugins = ['s2'];
  await saveBot(paths, main);
  await k.removeFromAllBots('plugins', 's2');
  bots = (await k.state()).bots;
  assert.deepEqual(bots.find((b) => b.id === 'main')!.extensions.plugins, []);
  assert.deepEqual(bots.find((b) => b.id === 'main')!.allowedMcpTools, ['s2/y']);
  await k.close();
});

test('updateBot：拒绝坏 extensions 与坏 allowedMcpTools；接受合法新字段', async () => {
  const h = await kernelHarness();
  await assert.rejects(
    h.kernel.updateBot(h.bot.id, { extensions: { web: true, plugins: [], mcpServers: [] } as never }),
    (err: unknown) => err instanceof KernelError && err.code === 'invalid',
  );
  await assert.rejects(
    h.kernel.updateBot(h.bot.id, { allowedMcpTools: ['no-slash'] }),
    (err: unknown) => err instanceof KernelError && err.code === 'invalid',
  );
  const updated = await h.kernel.updateBot(h.bot.id, {
    extensions: { web: true, plugins: ['p1'], mcpServers: ['s1'], skills: ['k1'] },
    allowWeb: true,
    allowedMcpTools: ['s1/x', 's1/x'],
  });
  assert.deepEqual(updated.extensions, { web: true, plugins: ['p1'], mcpServers: ['s1'], skills: ['k1'] });
  assert.equal(updated.allowWeb, true);
  assert.deepEqual(updated.allowedMcpTools, ['s1/x']);
  await h.close();
});

test('contextUsage：无消息时为 0；有基线时为基线 token 加其后消息的估算；线程不存在时报错', async () => {
  const root = await tmpRoot();
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: echoModel() });
  const provider = await kernel.addProvider({
    name: 'P',
    format: 'chat_completions',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'sk-ctx-123456',
  });
  const bot = await kernel.completeOnboarding({ providerId: provider.id, model: 'm' });
  await kernel.updateBot(bot.id, { contextWindow: 50_000 });
  const thread = kernel.createThread(bot.id);

  const empty = await kernel.contextUsage(thread.id);
  assert.equal(empty.window, 50_000);
  assert.equal(empty.tokens, 0);

  kernel.sendMessage(thread.id, '你好');
  await waitFor(() => kernel.listMessages(thread.id).some((m) => m.role === 'assistant'));
  await kernel.close();

  const reopened = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: echoModel() });
  const usage = await reopened.contextUsage(thread.id);
  // 基线 = echoModel 上报的 inputTokens 5（对应用户消息）；其后的助手回复按字符估算累加
  const reply = reopened.listMessages(thread.id).filter((m) => m.role === 'assistant');
  assert.equal(usage.tokens, 5 + estimateChars(JSON.stringify(reply)));
  assert.ok(usage.tokens > 5);
  await assert.rejects(() => reopened.contextUsage('missing'), KernelError);
  await reopened.close();
});
