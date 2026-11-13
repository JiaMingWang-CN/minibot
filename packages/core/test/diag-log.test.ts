import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DiagLog, type DiagEvent } from '../src/diag/log.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import { Kernel } from '../src/kernel.ts';
import { ModelError } from '../src/model/types.ts';
import { instrumentCallModel } from '../src/model/client.ts';
import { dataPaths } from '../src/paths.ts';
import { openDb } from '../src/db/db.ts';
import { newBot } from '../src/config/config.ts';
import { MemoryRevisions } from '../src/memory/revisions.ts';
import { ReadTracker } from '../src/tools/read-tracker.ts';
import { ApprovalBroker } from '../src/approval/broker.ts';
import { executeTool, type ToolEnv } from '../src/tools/registry.ts';
import type { Block } from '../src/model/types.ts';
import { fakeCrypto, kernelHarness, waitFor } from './kernel-harness.ts';
import { RelayLink } from '../src/remote/relay-link.ts';
import { RemoteService } from '../src/remote/service.ts';
import { generateKeyPair } from '../src/remote/noise.ts';
import { startRelay } from '../../relay/src/relay.ts';

const DAY = 24 * 3600_000;
/** 本地时区的中午，避免夏令时与日界线造成的偏差 */
const noon = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 12, 0, 0).getTime();
const fileOf = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `minibot-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`;
};

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minibot-diag-'));
}

async function lines(file: string): Promise<Record<string, unknown>[]> {
  const text = await fs.readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test('rotate by day', async () => {
  const dir = await tmpDir();
  let now = noon(2026, 11, 10);
  const log = new DiagLog({ dir, secrets: new SecretSet(), now: () => now });
  log.write('info', 'app', '第一天', { n: 1 });
  now = noon(2026, 11, 12);
  log.write('warn', 'app', '第三天', { n: 2 });
  await log.close();
  assert.deepEqual((await fs.readdir(dir)).sort(), [fileOf(noon(2026, 11, 10)), fileOf(noon(2026, 11, 12))]);
  const [a] = await lines(path.join(dir, fileOf(noon(2026, 11, 10))));
  assert.deepEqual(a, { ts: noon(2026, 11, 10), level: 'info', area: 'app', msg: '第一天', n: 1 });
  const [b] = await lines(path.join(dir, fileOf(noon(2026, 11, 12))));
  assert.equal(b!['msg'], '第三天');
  assert.equal(b!['level'], 'warn');
});

test('fields 不能覆盖 ts/level/area/msg', async () => {
  const dir = await tmpDir();
  const now = noon(2026, 11, 10);
  const log = new DiagLog({ dir, secrets: new SecretSet(), now: () => now });
  log.write('info', 'app', 'm', { ts: 1, level: 'x', area: 'y', msg: 'z', ok: true });
  await log.close();
  const [row] = await lines(path.join(dir, fileOf(now)));
  assert.deepEqual(row, { ts: now, level: 'info', area: 'app', msg: 'm', ok: true });
});

test('retention: 超过 7 天的删除', async () => {
  const dir = await tmpDir();
  const now = noon(2026, 11, 12);
  for (let age = 0; age < 9; age += 1) await fs.writeFile(path.join(dir, fileOf(now - age * DAY)), 'x\n');
  await fs.writeFile(path.join(dir, 'other.txt'), 'keep');
  const log = new DiagLog({ dir, secrets: new SecretSet(), now: () => now });
  await log.close();
  const left = (await fs.readdir(dir)).filter((n) => n.startsWith('minibot-')).sort();
  assert.deepEqual(left, Array.from({ length: 7 }, (_, age) => fileOf(now - age * DAY)).sort());
  assert.ok((await fs.readdir(dir)).includes('other.txt'));
});

test('retention: 总量超限从最旧删起', async () => {
  const dir = await tmpDir();
  const now = noon(2026, 11, 12);
  for (let age = 0; age < 5; age += 1) await fs.writeFile(path.join(dir, fileOf(now - age * DAY)), 'x'.repeat(100));
  const log = new DiagLog({ dir, secrets: new SecretSet(), now: () => now, maxBytes: 250 });
  await log.close();
  assert.deepEqual((await fs.readdir(dir)).sort(), [fileOf(now - DAY), fileOf(now)].sort());
});

test('secret redaction', async () => {
  const dir = await tmpDir();
  const now = noon(2026, 11, 12);
  const secrets = new SecretSet();
  secrets.add('sk-test-1234567890abcdef');
  const log = new DiagLog({ dir, secrets, now: () => now });
  log.write('error', 'model', '密钥 sk-test-1234567890abcdef 失败', { header: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789', nested: { k: ['sk-test-1234567890abcdef'] } });
  log.write('error', 'model', '异常', { err: new Error('bad sk-test-1234567890abcdef') });
  await log.close();
  const raw = await fs.readFile(path.join(dir, fileOf(now)), 'utf8');
  assert.ok(!raw.includes('sk-test-1234567890abcdef'));
  assert.ok(!raw.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
  const [first] = await lines(path.join(dir, fileOf(now)));
  assert.equal(first!['msg'], '密钥 [REDACTED_API_KEY] 失败');
  assert.equal(first!['header'], '[REDACTED]');
  assert.deepEqual(first!['nested'], { k: ['[REDACTED_API_KEY]'] });
});

test('event whitelist', async () => {
  const dir = await tmpDir();
  const now = noon(2026, 11, 12);
  const log = new DiagLog({
    dir,
    secrets: new SecretSet(),
    now: () => now,
    pathContext: () => ({ home: '/home/bob', workspaces: [], user: 'bob', host: 'box' }),
  });
  const got: (DiagEvent & { ts: number })[] = [];
  const off = log.onEvent((e) => got.push(e));
  const bad = { a: 1 } as unknown as string;
  log.write('error', 'model', 'x', {}, {
    kind: 'error',
    name: 'model.request',
    data: { status: 500, ok: false, none: null, kind: 'server', obj: bad, long: 'x'.repeat(200), path: '/home/bob/a.txt' },
  });
  assert.equal(got.length, 1);
  assert.equal(got[0]!.ts, now);
  assert.equal(got[0]!.kind, 'error');
  assert.equal(got[0]!.name, 'model.request');
  assert.deepEqual(got[0]!.data, { status: 500, ok: false, none: null, kind: 'server', path: '~/a.txt' });

  // stack：≤4096 字、允许换行、其他控制字符丢弃
  const stack = 'at a (x.ts:1:1)\nat b (y.ts:2:2)';
  log.write('error', 'app', 'x', {}, { kind: 'crash', name: 'app.crash', data: { stack, other: 'ok' } });
  assert.equal(got[1]!.data['stack'], stack);
  log.write('error', 'app', 'x', {}, { kind: 'crash', name: 'app.crash', data: { stack: 'at a\u001b[31m' } });
  assert.deepEqual(got[2]!.data, {});
  log.write('error', 'app', 'x', {}, { kind: 'crash', name: 'app.crash', data: { stack: 'x'.repeat(4097) } });
  assert.deepEqual(got[3]!.data, {});
  log.write('error', 'app', 'x', {}, { kind: 'crash', name: 'app.crash', data: { stack: 'x'.repeat(4096) } });
  assert.equal((got[4]!.data['stack'] as string).length, 4096);

  // 非法的事件名：整个事件丢弃
  log.write('error', 'app', 'x', {}, { kind: 'error', name: 'Bad Name', data: {} });
  assert.equal(got.length, 5);

  off();
  log.write('error', 'app', 'x', {}, { kind: 'error', name: 'app.after', data: {} });
  assert.equal(got.length, 5);

  await log.close();
  const rows = await lines(path.join(dir, fileOf(now)));
  // 被丢弃的字段在日志里留一条 warn，且不含字段值
  const warns = rows.filter((r) => r['level'] === 'warn' && r['area'] === 'diag');
  assert.ok(warns.length >= 4);
  assert.ok(!JSON.stringify(warns).includes('xxxxxxxx'));
});

test('订阅者抛错不影响写入', async () => {
  const dir = await tmpDir();
  const now = noon(2026, 11, 12);
  const log = new DiagLog({ dir, secrets: new SecretSet(), now: () => now });
  log.onEvent(() => {
    throw new Error('subscriber');
  });
  log.write('error', 'app', 'x', {}, { kind: 'error', name: 'app.x', data: {} });
  await log.close();
  assert.equal((await lines(path.join(dir, fileOf(now)))).length, 1);
});

test('unwritable dir', async () => {
  const root = await tmpDir();
  const dir = path.join(root, 'logs');
  await fs.writeFile(dir, '我是文件');
  const log = new DiagLog({ dir, secrets: new SecretSet() });
  const got: unknown[] = [];
  log.onEvent((e) => got.push(e));
  assert.doesNotThrow(() => log.write('error', 'app', 'x', { a: 1 }, { kind: 'error', name: 'app.x', data: {} }));
  await assert.doesNotReject(log.close());
  // 事件仍然送出
  assert.equal(got.length, 1);
  assert.equal(await fs.readFile(dir, 'utf8'), '我是文件');
});

test('close 之后的写入被忽略', async () => {
  const dir = await tmpDir();
  const now = noon(2026, 11, 12);
  const log = new DiagLog({ dir, secrets: new SecretSet(), now: () => now });
  await log.close();
  assert.doesNotThrow(() => log.write('info', 'app', 'late'));
  await log.close();
  assert.deepEqual(await fs.readdir(dir), []);
});

test('recent: 按时间与字节数取尾部', async () => {
  const dir = await tmpDir();
  let now = noon(2026, 11, 11);
  const log = new DiagLog({ dir, secrets: new SecretSet(), now: () => now });
  log.write('info', 'app', 'old');
  now = noon(2026, 11, 12);
  for (let i = 0; i < 5; i += 1) {
    now += 1000;
    log.write('info', 'app', `m${i}`);
  }
  const since = noon(2026, 11, 12);
  const all = await log.recent(since, 1_000_000);
  const msgs = all.split('\n').filter((l) => l).map((l) => (JSON.parse(l) as { msg: string }).msg);
  assert.deepEqual(msgs, ['m0', 'm1', 'm2', 'm3', 'm4']);
  const tail = await log.recent(since, 130);
  const tailMsgs = tail.split('\n').filter((l) => l).map((l) => (JSON.parse(l) as { msg: string }).msg);
  assert.ok(tailMsgs.length >= 1 && tailMsgs.length < 5);
  assert.equal(tailMsgs.at(-1), 'm4');
  assert.ok(Buffer.byteLength(tail) <= 130);
  await log.close();
});

test('model failure instrumented', async () => {
  const root = await tmpDir();
  const kernel = await Kernel.open({
    dataRoot: root,
    crypto: fakeCrypto(),
    appVersion: '9.9.9',
    retryDelaysMs: [1],
    callModel: async () => {
      throw new ModelError('server', 'HTTP 500：upstream exploded sk-harness-secret-123', { status: 500 });
    },
  });
  const events: (DiagEvent & { ts: number })[] = [];
  kernel.diag.onEvent((e) => events.push(e));
  const provider = await kernel.addProvider({
    name: 'Mine',
    format: 'chat_completions',
    baseUrl: 'http://secret-host.example/v1',
    apiKey: 'sk-harness-secret-123',
  });
  const bot = await kernel.completeOnboarding({ providerId: provider.id, model: 'my-model' });
  const turnEvents: string[] = [];
  kernel.on((e) => {
    if (e.type === 'turn') turnEvents.push(e.state);
  });
  kernel.sendMessage(kernel.createThread(bot.id).id, '这是消息正文');
  await waitFor(() => turnEvents.includes('idle'));
  const failures = events.filter((e) => e.name === 'model.request');
  assert.ok(failures.length >= 1);
  const data = failures[0]!.data;
  assert.equal(failures[0]!.kind, 'error');
  assert.deepEqual(Object.keys(data).sort(), ['errorKind', 'format', 'model', 'status']);
  assert.equal(data['status'], 500);
  assert.equal(data['errorKind'], 'server');
  assert.equal(data['format'], 'chat_completions');
  assert.equal(data['model'], 'my-model');
  await kernel.close();

  const dir = dataPaths(await fs.realpath(root)).logsDir;
  const file = (await fs.readdir(dir)).find((n) => n.startsWith('minibot-'))!;
  const rows = await lines(path.join(dir, file));
  const failure = rows.find((r) => r['area'] === 'model' && r['level'] === 'error');
  assert.ok(failure !== undefined);
  assert.match(String(failure['error']), /upstream exploded/);
  const raw = await fs.readFile(path.join(dir, file), 'utf8');
  assert.ok(!raw.includes('sk-harness-secret-123'));
  assert.ok(!raw.includes('这是消息正文'));
  assert.ok(!raw.includes('secret-host.example'));
  const start = rows.find((r) => r['area'] === 'app' && r['msg'] === 'app.start');
  assert.equal(start?.['appVersion'], '9.9.9');
});

test('app.start 事件带 appVersion 与 os', async () => {
  const root = await tmpDir();
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), appVersion: '1.2.3' });
  const dir = dataPaths(await fs.realpath(root)).logsDir;
  await kernel.close();
  const file = (await fs.readdir(dir)).find((n) => n.startsWith('minibot-'))!;
  const rows = await lines(path.join(dir, file));
  const start = rows.find((r) => r['msg'] === 'app.start');
  assert.equal(start?.['appVersion'], '1.2.3');
  assert.equal(typeof start?.['os'], 'string');
});

async function toolSetup(): Promise<{ env: ToolEnv; diag: DiagLog; dir: string; workspace: string; close(): Promise<void> }> {
  const root = await tmpDir();
  const paths = dataPaths(root);
  const workspace = paths.defaultWorkspace('b1');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(paths.memoryDir('b1'), { recursive: true });
  const db = openDb(paths.db);
  const dir = path.join(root, 'logs');
  const diag = new DiagLog({ dir, secrets: new SecretSet(), now: () => noon(2026, 11, 12) });
  const env: ToolEnv = {
    bot: newBot('b1'),
    threadId: 't1',
    workspace,
    paths,
    home: path.join(root, 'home'),
    tracker: new ReadTracker(),
    secrets: new SecretSet(),
    revisions: new MemoryRevisions(db, paths),
    broker: new ApprovalBroker(() => {}),
    signal: new AbortController().signal,
    diag,
  };
  return { env, diag, dir, workspace, close: async () => { db.close(); await diag.close(); } };
}

const toolCall = (name: string, input: Record<string, unknown>): Extract<Block, { type: 'tool_use' }> => ({
  type: 'tool_use',
  id: 'tu_1',
  name,
  input,
});

test('tool failure instrumented', async () => {
  const { env, diag, dir, workspace, close } = await toolSetup();
  const events: (DiagEvent & { ts: number })[] = [];
  diag.onEvent((e) => events.push(e));
  env.bot.approvalMode = 'auto';
  const missing = path.join(workspace, 'nope.txt');
  const result = await executeTool(toolCall('read_file', { path: missing }), env);
  assert.equal(result.status, 'error');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'error');
  assert.equal(events[0]!.name, 'tool.read_file');
  assert.deepEqual(Object.keys(events[0]!.data).sort(), ['category']);

  // 参数错误是模型的问题，只记日志，不产生事件
  await executeTool(toolCall('read_file', { path: 5 }), env);
  assert.equal(events.length, 1);

  await close();
  const rows = await lines(path.join(dir, fileOf(noon(2026, 11, 12))));
  const calls = rows.filter((r) => r['area'] === 'tool');
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!['tool'], 'read_file');
  assert.equal(calls[0]!['status'], 'error');
  assert.equal(typeof calls[0]!['durationMs'], 'number');
});

test('run_command 超时与退出码被记录', async () => {
  const { env, diag, dir, workspace, close } = await toolSetup();
  const events: (DiagEvent & { ts: number })[] = [];
  diag.onEvent((e) => events.push(e));
  env.bot.approvalMode = 'auto';
  await fs.writeFile(path.join(workspace, 'exit3.js'), 'process.exit(3);');
  await fs.writeFile(path.join(workspace, 'sleep.js'), 'setTimeout(() => {}, 5000);');
  await executeTool(toolCall('run_command', { command: 'node exit3.js' }), env);
  // 退出码非 0 很常见（如 grep 无匹配），只记日志不产生事件
  assert.equal(events.length, 0);
  await executeTool(toolCall('run_command', { command: 'node sleep.js', timeout_ms: 300 }), env);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.name, 'tool.run_command');
  assert.equal(events[0]!.data['category'], 'timeout');
  await close();
  const rows = await lines(path.join(dir, fileOf(noon(2026, 11, 12)))).then((r) => r.filter((x) => x['area'] === 'tool'));
  // PowerShell 会把非 0 的退出码折成 1，所以只断言非 0
  assert.equal(typeof rows[0]!['exitCode'], 'number');
  assert.notEqual(rows[0]!['exitCode'], 0);
  assert.equal(typeof rows[0]!['command'], 'string');
});

test('remote: 口令错误产生 remote.connect 事件，日志不含口令与地址', async () => {
  const relay = await startRelay({ host: '127.0.0.1', port: 0, token: 'right-relay-token-123456' });
  const dir = await tmpDir();
  const now = noon(2026, 11, 12);
  const diag = new DiagLog({ dir, secrets: new SecretSet(), now: () => now });
  const events: (DiagEvent & { ts: number })[] = [];
  diag.onEvent((e) => events.push(e));
  const states: string[] = [];
  const link = new RelayLink({
    url: `ws://127.0.0.1:${relay.port}/v1`,
    token: 'wrong-relay-token-123456',
    identity: generateKeyPair(),
    accept: () => {},
    onState: (state) => states.push(state),
    diag,
  });
  try {
    link.start();
    await waitFor(() => events.length >= 1);
    assert.equal(events[0]!.kind, 'error');
    assert.equal(events[0]!.name, 'remote.connect');
    assert.equal(events[0]!.data['code'], 4401);
  } finally {
    link.stop();
    await relay.close();
    await diag.close();
  }
  const raw = await fs.readFile(path.join(dir, fileOf(now)), 'utf8');
  assert.ok(!raw.includes('wrong-relay-token-123456'));
  assert.ok(!raw.includes(String(relay.port)));
  assert.match(raw, /relay\.disconnected/);
});

test('remote: 中继口令登记为密钥', async () => {
  const h = await kernelHarness();
  const service = await RemoteService.start(h.kernel, { dataRoot: h.root, crypto: fakeCrypto() });
  try {
    await service.updateConfig({ relayToken: 'relay-secret-token-987654' });
    h.kernel.diag.write('info', 'test', '口令是 relay-secret-token-987654');
  } finally {
    await service.close();
    await h.close();
  }
  const dir = dataPaths(await fs.realpath(h.root)).logsDir;
  const file = (await fs.readdir(dir)).find((n) => n.startsWith('minibot-'))!;
  const raw = await fs.readFile(path.join(dir, file), 'utf8');
  assert.ok(!raw.includes('relay-secret-token-987654'));
  assert.match(raw, /REDACTED_API_KEY/);
});

test('run_command 超时：命令输出不进日志', async () => {
  const { env, dir, workspace, close } = await toolSetup();
  env.bot.approvalMode = 'auto';
  await fs.writeFile(path.join(workspace, 'noisy.js'), "console.log('OUTPUT-MARKER-ZXQ'); setTimeout(() => {}, 5000);");
  const result = await executeTool(toolCall('run_command', { command: 'node noisy.js', timeout_ms: 500 }), env);
  // 先确认输出确实被捕获，否则下面的断言没有意义
  assert.match(result.content, /OUTPUT-MARKER-ZXQ/);
  await close();
  const raw = await fs.readFile(path.join(dir, fileOf(noon(2026, 11, 12))), 'utf8');
  assert.ok(!raw.includes('OUTPUT-MARKER-ZXQ'));
  const row = (await lines(path.join(dir, fileOf(noon(2026, 11, 12)))))[0]!;
  assert.equal(row['timedOut'], true);
  assert.equal(row['error'], undefined);
});

test('callModel 结果缺 usage：调用成功，没有 model.request 错误事件', async () => {
  const dir = await tmpDir();
  const diag = new DiagLog({ dir, secrets: new SecretSet(), now: () => noon(2026, 11, 12) });
  const events: (DiagEvent & { ts: number })[] = [];
  diag.onEvent((e) => events.push(e));
  const reply = { blocks: [{ type: 'text', text: '好' }], stopReason: 'end' };
  const wrapped = instrumentCallModel(async () => reply as never, diag);
  const result = await wrapped({
    provider: { id: 'p', name: 'P', format: 'chat_completions', baseUrl: 'http://x' },
    apiKey: 'k',
    request: { model: 'm', system: '', messages: [], tools: [], maxTokens: 1, thinkingLevel: null },
    signal: new AbortController().signal,
    onDelta: () => {},
  });
  assert.equal(result, reply);
  assert.equal(events.length, 0);
  await diag.close();
  const rows = await lines(path.join(dir, fileOf(noon(2026, 11, 12))));
  assert.equal(rows[0]!['msg'], 'model.request');
  assert.equal(rows[0]!['ok'], true);
});

test('stack 键的值不是字符串：丢弃该字段', async () => {
  const dir = await tmpDir();
  const log = new DiagLog({ dir, secrets: new SecretSet(), now: () => noon(2026, 11, 12) });
  const got: (DiagEvent & { ts: number })[] = [];
  log.onEvent((e) => got.push(e));
  log.write('error', 'app', 'x', {}, { kind: 'crash', name: 'app.crash', data: { stack: 5 as unknown as string, ok: true } });
  assert.deepEqual(got[0]!.data, { ok: true });
  await log.close();
});

test('bot 工作区登记后，recent() 把它替换成 <workspace>', async () => {
  const root = await tmpDir();
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto() });
  const provider = await kernel.addProvider({ name: 'P', format: 'chat_completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-ws-secret-12345' });
  const workspace = path.join(await fs.realpath(root), 'my-project');
  await kernel.completeOnboarding({ providerId: provider.id, model: 'm', workspace });
  kernel.diag.write('info', 'test', 'open ' + workspace + path.sep + 'a.txt');
  const out = await kernel.diag.recent(0, 100_000);
  await kernel.close();
  assert.match(out, /open <workspace>/);
  assert.ok(!out.includes('my-project'));
});

test('重新打开内核时，已有 bot 的工作区也会登记', async () => {
  const root = await tmpDir();
  const first = await Kernel.open({ dataRoot: root, crypto: fakeCrypto() });
  const provider = await first.addProvider({ name: 'P', format: 'chat_completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-ws-secret-12345' });
  const workspace = path.join(await fs.realpath(root), 'reopen-project');
  await first.completeOnboarding({ providerId: provider.id, model: 'm', workspace });
  await first.close();
  const second = await Kernel.open({ dataRoot: root, crypto: fakeCrypto() });
  second.diag.write('info', 'test', 'open ' + workspace + path.sep + 'b.txt');
  const out = await second.diag.recent(0, 100_000);
  await second.close();
  assert.match(out, /open <workspace>/);
});

test('flushSync: 崩溃时同步落盘', async () => {
  const dir = await tmpDir();
  const log = new DiagLog({ dir, secrets: new SecretSet() });
  log.write('error', 'app', 'crash line');
  log.flushSync();
  const text = await fs.readFile(path.join(dir, fileOf(Date.now())), 'utf8');
  assert.ok(text.includes('crash line'));
  await log.close();
});

test('flushSync: 正在异步写盘的那一批也同步补上', async () => {
  const dir = await tmpDir();
  const log = new DiagLog({ dir, secrets: new SecretSet() });
  // 先等启动时的清理等 IO 做完，让下一次写盘立刻开始
  await log.recent(0, 1);
  log.write('info', 'app', 'in flight line');
  // 让异步写盘开始（已从缓冲取走这一批，但还没写完），再模拟崩溃
  await new Promise((resolve) => setImmediate(resolve));
  log.flushSync();
  const text = readFileSync(path.join(dir, fileOf(Date.now())), 'utf8');
  assert.ok(text.includes('in flight line'));
  await log.close();
});
