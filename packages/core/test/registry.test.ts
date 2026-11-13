import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths } from '../src/paths.ts';
import { openDb } from '../src/db/db.ts';
import { newBot } from '../src/config/config.ts';
import { MemoryRevisions } from '../src/memory/revisions.ts';
import { SecretSet, REDACTED } from '../src/secrets/redact.ts';
import { ReadTracker } from '../src/tools/read-tracker.ts';
import { ApprovalBroker } from '../src/approval/broker.ts';
import { TOOL_SPECS, executeTool, type ToolEnv } from '../src/tools/registry.ts';
import { ToolCatalog, type ExternalTool } from '../src/tools/catalog.ts';
import { DiagLog, type TimedDiagEvent } from '../src/diag/log.ts';
import type { Block } from '../src/model/types.ts';

type ToolUse = Extract<Block, { type: 'tool_use' }>;

function call(name: string, input: Record<string, unknown>): ToolUse {
  return { type: 'tool_use', id: 'tu_1', name, input };
}

async function setup(): Promise<{
  root: string;
  paths: ReturnType<typeof dataPaths>;
  env: ToolEnv;
  broker: ApprovalBroker;
  close(): void;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-registry-'));
  const paths = dataPaths(root);
  const workspace = paths.defaultWorkspace('b1');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(paths.memoryDir('b1'), { recursive: true });
  const db = openDb(paths.db);
  const broker = new ApprovalBroker(() => {});
  const bot = newBot('b1');
  const env: ToolEnv = {
    bot,
    threadId: 't1',
    workspace,
    paths,
    home: path.join(root, 'home'),
    tracker: new ReadTracker(),
    secrets: new SecretSet(),
    revisions: new MemoryRevisions(db, paths),
    broker,
    signal: new AbortController().signal,
  };
  return { root, paths, env, broker, close: () => db.close() };
}

async function waitForPending(broker: ApprovalBroker) {
  for (let i = 0; i < 200; i += 1) {
    const pending = broker.pending();
    if (pending.length > 0) return pending[0]!;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('没有等到审批请求');
}

test('工具清单为 6 个工具', () => {
  assert.deepEqual(
    TOOL_SPECS.map((t) => t.name),
    ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'run_command'],
  );
});

test('未知工具或参数类型不对 → status error', async () => {
  const { env, close } = await setup();
  const unknown = await executeTool(call('nope', {}), env);
  assert.equal(unknown.status, 'error');
  assert.ok(unknown.content.includes('未知工具'));
  const badType = await executeTool(call('read_file', { path: 123 }), env);
  assert.equal(badType.status, 'error');
  assert.ok(badType.content.includes('参数错误'));
  const missing = await executeTool(call('run_command', {}), env);
  assert.equal(missing.status, 'error');
  close();
});

test('ask 模式下写文件先发审批；拒绝 → status denied，content "用户拒绝了此操作"', async () => {
  const { paths, env, broker, close } = await setup();
  env.bot.approvalMode = 'ask';
  const target = path.join(paths.defaultWorkspace('b1'), 'w.txt');
  const promise = executeTool(call('write_file', { path: 'w.txt', content: 'x' }), env);
  const request = await waitForPending(broker);
  assert.equal(request.tool, 'write_file');
  assert.equal(request.botId, 'b1');
  assert.equal(request.threadId, 't1');
  assert.ok(request.summary.includes('w.txt'));
  broker.respond(request.id, false);
  const result = await promise;
  assert.equal(result.status, 'denied');
  assert.equal(result.content, '用户拒绝了此操作');
  await assert.rejects(fs.access(target));
  close();
});

test('审批等待中 abort → status cancelled', async () => {
  const { env, broker, close } = await setup();
  env.bot.approvalMode = 'ask';
  const controller = new AbortController();
  env.signal = controller.signal;
  const promise = executeTool(call('write_file', { path: 'a.txt', content: 'x' }), env);
  await waitForPending(broker);
  controller.abort();
  const result = await promise;
  assert.equal(result.status, 'cancelled');
  close();
});

test('工具结果出口统一脱敏', async () => {
  const { paths, env, close } = await setup();
  const key = 'sk-12345678';
  env.secrets.add(key);
  const file = path.join(paths.defaultWorkspace('b1'), 'secret.txt');
  await fs.writeFile(file, `x ${key} y`);
  env.bot.approvalMode = 'ask';
  const result = await executeTool(call('read_file', { path: 'secret.txt' }), env);
  assert.equal(result.status, 'ok');
  assert.ok(result.content.includes(REDACTED));
  assert.equal(result.content.includes(key), false);
  close();
});

test('异常不外抛，转成 status error，错误信息也经过脱敏', async () => {
  const { env, close } = await setup();
  env.bot.approvalMode = 'ask';
  const result = await executeTool(call('read_file', { path: '.' }), env);
  assert.equal(result.status, 'error');
  assert.ok(result.content.includes('工具执行失败'));
  close();
});

test('审批摘要含命令原文或目标路径', async () => {
  const { env, broker, close } = await setup();
  env.bot.approvalMode = 'ask';
  const promise = executeTool(call('run_command', { command: 'echo hello-approval' }), env);
  const request = await waitForPending(broker);
  assert.ok(request.summary.includes('echo hello-approval'));
  broker.respond(request.id, false);
  const result = await promise;
  assert.equal(result.status, 'denied');
  close();
});

test('auto 模式下敏感路径仍需审批', async () => {
  const { paths, env, broker, close } = await setup();
  env.bot.approvalMode = 'auto';
  await fs.writeFile(paths.secrets, 'dummy');
  const promise = executeTool(call('read_file', { path: paths.secrets }), env);
  const request = await waitForPending(broker);
  assert.equal(request.tool, 'read_file');
  broker.respond(request.id, false);
  await promise;
  close();
});

test('审批请求带内容预览：write_file 是写入内容，edit_file 是旧/新文本；脱敏、截断', async () => {
  const { env, broker, close } = await setup();
  env.bot.approvalMode = 'ask';
  env.secrets.add('sk-preview-secret-123');

  const writing = executeTool(call('write_file', { path: 'w.txt', content: `key=sk-preview-secret-123\n${'a'.repeat(6000)}` }), env);
  const writeRequest = await waitForPending(broker);
  assert.ok(writeRequest.preview!.startsWith(`key=${REDACTED}`));
  assert.ok(!writeRequest.preview!.includes('sk-preview-secret-123'));
  assert.ok(writeRequest.preview!.includes('已截断'));
  assert.ok(writeRequest.preview!.length < 4200);
  broker.respond(writeRequest.id, false);
  await writing;

  const editing = executeTool(call('edit_file', { path: 'w.txt', old_string: '旧的', new_string: '新的' }), env);
  const editRequest = await waitForPending(broker);
  assert.ok(editRequest.preview!.includes('旧的') && editRequest.preview!.includes('新的'));
  broker.respond(editRequest.id, false);
  await editing;

  const running = executeTool(call('run_command', { command: 'echo hi' }), env);
  const commandRequest = await waitForPending(broker);
  assert.equal(commandRequest.preview, undefined);
  broker.respond(commandRequest.id, false);
  await running;
  close();
});

function externalTool(
  name: string,
  run: ExternalTool['run'],
  source: 'web' | 'mcp' = 'mcp',
): ExternalTool {
  return {
    spec: { name, description: name, parameters: { type: 'object', properties: {} } },
    source: source === 'web' ? { kind: 'web' } : { kind: 'mcp', serverId: 's1', serverName: 'S1', toolName: name },
    summarize: () => `调用 ${name}`,
    run,
  };
}

async function setupExternal(tools: ExternalTool[], mode: 'ask' | 'auto' = 'auto') {
  const base = await setup();
  base.env.bot.approvalMode = mode;
  const catalog = new ToolCatalog();
  catalog.register({ toolsFor: async () => tools });
  base.env.toolset = await catalog.snapshot(base.env.bot);
  return base;
}

test('外部工具结果超过 30000 字符：截断并写入 outputs 目录', async () => {
  const { paths, env, close } = await setupExternal([
    externalTool('fake__big', async () => ({ content: 'x'.repeat(40000), isError: false })),
  ]);
  const result = await executeTool(call('fake__big', {}), env);
  assert.equal(result.status, 'ok');
  assert.ok(result.content.includes('完整输出见'));
  const files = await fs.readdir(paths.outputs);
  assert.equal(files.length, 1);
  close();
});

test('外部工具结果出口脱敏', async () => {
  const key = 'sk-external-secret-123';
  const { env, close } = await setupExternal([
    externalTool('fake__leak', async () => ({ content: `key=${key}`, isError: false })),
  ]);
  env.secrets.add(key);
  const result = await executeTool(call('fake__leak', {}), env);
  assert.equal(result.status, 'ok');
  assert.ok(result.content.includes(REDACTED));
  assert.equal(result.content.includes(key), false);
  close();
});

test('外部工具抛异常 → 工具执行失败：boom，不外抛', async () => {
  const { env, close } = await setupExternal([
    externalTool('fake__boom', async () => {
      throw new Error('boom');
    }),
  ]);
  const result = await executeTool(call('fake__boom', {}), env);
  assert.equal(result.status, 'error');
  assert.equal(result.content, '工具执行失败：boom');
  close();
});

test('未知外部工具 → 未知工具，且不发诊断错误事件', async () => {
  const { root, env, close } = await setupExternal([]);
  const events: TimedDiagEvent[] = [];
  const diag = new DiagLog({ dir: path.join(root, 'logs'), secrets: env.secrets });
  diag.onEvent((e) => events.push(e));
  env.diag = diag;
  const result = await executeTool(call('nope__x', {}), env);
  assert.equal(result.status, 'error');
  assert.ok(result.content.startsWith('未知工具'));
  assert.equal(events.some((e) => e.kind === 'error'), false);
  await diag.close();
  close();
});

test('外部工具名与内置工具同名时，执行仍走内置逻辑', async () => {
  const { env, close } = await setupExternal([
    externalTool('read_file', async () => ({ content: '外部实现', isError: false })),
  ]);
  env.bot.approvalMode = 'ask';
  const result = await executeTool(call('read_file', {}), env);
  assert.equal(result.status, 'error');
  assert.ok(result.content.includes('参数错误'));
  close();
});

