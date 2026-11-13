import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, isSimpleCommand, type ToolName } from '../src/approval/policy.ts';
import type { PathClass } from '../src/tools/path-guard.ts';
import { KernelError } from '../src/kernel.ts';
import type { CallModel } from '../src/model/client.ts';
import type { ApprovalRequest } from '../src/approval/broker.ts';
import type { ExternalTool } from '../src/tools/catalog.ts';
import { kernelHarness, waitFor, waitIdle } from './kernel-harness.ts';

const cases: ['edits', ToolName, PathClass[], 'allow' | 'ask'][] = [
  ['edits', 'write_file', ['workspace'], 'allow'],
  ['edits', 'edit_file', ['workspace'], 'allow'],
  ['edits', 'edit_file', ['own_memory'], 'allow'],
  ['edits', 'write_file', ['outside'], 'ask'],
  ['edits', 'write_file', ['sensitive'], 'ask'],
  ['edits', 'read_file', ['workspace'], 'allow'],
  ['edits', 'read_file', ['outside'], 'ask'],
  ['edits', 'run_command', [], 'ask'],
];

test('审批矩阵：编辑自动档', () => {
  for (const [mode, tool, classes, expected] of cases) {
    assert.equal(decide(mode, tool, classes), expected, `${mode} ${tool} ${classes}`);
  }
});

test('isSimpleCommand：带管道、重定向、串联、变量、子命令的不算简单命令', () => {
  for (const ok of ['npm test', 'git status', 'pytest -q tests/unit', 'node --test packages/core/test/']) {
    assert.equal(isSimpleCommand(ok), true, ok);
  }
  for (const bad of [
    'npm test | tee log',
    'ls > out.txt',
    'cat < a',
    'a && b',
    'a || b',
    'a; b',
    'echo $HOME',
    'echo `whoami`',
    'echo $(whoami)',
    'a & b',
    'line1\nline2',
    '',
    '   ',
  ]) {
    assert.equal(isSimpleCommand(bad), false, bad);
  }
});

function commandModel(command: string): CallModel {
  let n = 0;
  return async () => {
    n += 1;
    if (n % 2 === 1) {
      return {
        blocks: [{ type: 'tool_use', id: `tu_${n}`, name: 'run_command', input: { command } }],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    return { blocks: [{ type: 'text', text: '完成' }], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } };
  };
}

function requests(h: Awaited<ReturnType<typeof kernelHarness>>): ApprovalRequest[] {
  return h.events
    .filter((e) => e.type === 'approval_request')
    .map((e) => (e as { request: ApprovalRequest }).request);
}

test('总是允许：批准时勾选后记入 bot.allowedCommands，同一条命令下次不再询问，决策日志记为 allowlist', async () => {
  const h = await kernelHarness(commandModel('node --version'));
  h.kernel.sendMessage(h.threadId, '看看版本');
  await waitFor(() => requests(h).length === 1);
  const req = requests(h)[0]!;
  assert.equal(req.command, 'node --version');
  assert.equal(req.canAlwaysAllow, true);
  // 内置工具的请求不带外部工具的新字段
  assert.equal(req.source, undefined);
  assert.equal(req.alwaysKind, undefined);
  assert.equal(h.kernel.respondApproval(req.id, true, true), true);
  await waitIdle(h, 1);
  // 白名单是异步落盘的，等它写完再断言，避免负载高时读到旧值
  let bot = (await h.kernel.state()).bots.find((b) => b.id === h.bot.id)!;
  for (let i = 0; i < 200 && bot.allowedCommands.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    bot = (await h.kernel.state()).bots.find((b) => b.id === h.bot.id)!;
  }
  assert.deepEqual(bot.allowedCommands, ['node --version']);

  h.kernel.sendMessage(h.threadId, '再看一次');
  await waitIdle(h, 2);
  assert.equal(requests(h).length, 1);

  const log = h.kernel.approvalLog({ botId: h.bot.id });
  assert.equal(log.length, 2);
  // 新的在前
  assert.equal(log[0]!.decidedBy, 'allowlist');
  assert.equal(log[0]!.result, 'approved');
  assert.equal(log[1]!.decidedBy, 'user');
  assert.equal(log[1]!.result, 'approved');
  assert.equal(log[1]!.always, true);
  assert.equal(log[1]!.tool, 'run_command');
  assert.match(log[1]!.summary, /node --version/);
  await h.close();
});

test('总是允许：复杂命令不提供该选项，带 always 批准也不会记入白名单', async () => {
  const h = await kernelHarness(commandModel('node --version | more'));
  h.kernel.sendMessage(h.threadId, '看看');
  await waitFor(() => requests(h).length === 1);
  const req = requests(h)[0]!;
  assert.equal(req.canAlwaysAllow, false);
  h.kernel.respondApproval(req.id, true, true);
  await waitIdle(h, 1);
  const bot = (await h.kernel.state()).bots.find((b) => b.id === h.bot.id)!;
  assert.deepEqual(bot.allowedCommands, []);
  await h.close();
});

test('决策日志：拒绝记为 denied / user；中止记为 cancelled / system', async () => {
  const h = await kernelHarness(commandModel('node --version'));
  h.kernel.sendMessage(h.threadId, '一');
  await waitFor(() => requests(h).length === 1);
  h.kernel.respondApproval(requests(h)[0]!.id, false);
  await waitIdle(h, 1);
  h.kernel.sendMessage(h.threadId, '二');
  await waitFor(() => requests(h).length === 2);
  h.kernel.abort(h.threadId);
  await waitIdle(h, 2);
  const log = h.kernel.approvalLog({});
  assert.deepEqual(
    log.map((x) => [x.result, x.decidedBy]),
    [
      ['cancelled', 'system'],
      ['denied', 'user'],
    ],
  );
  await h.close();
});

test('updateBot：approvalMode 接受 edits；allowedCommands 只能是去重后的简单命令列表', async () => {
  const h = await kernelHarness();
  const bot = await h.kernel.updateBot(h.bot.id, { approvalMode: 'edits' });
  assert.equal(bot.approvalMode, 'edits');
  const updated = await h.kernel.updateBot(h.bot.id, { allowedCommands: ['npm test', 'npm test', 'git status'] });
  assert.deepEqual(updated.allowedCommands, ['npm test', 'git status']);
  await assert.rejects(
    h.kernel.updateBot(h.bot.id, { allowedCommands: ['rm -rf / ; echo'] }),
    (e) => e instanceof KernelError && e.code === 'invalid',
  );
  await assert.rejects(
    h.kernel.updateBot(h.bot.id, { approvalMode: 'yolo' as never }),
    (e) => e instanceof KernelError && e.code === 'invalid',
  );
  await h.close();
});

function externalTool(name: string, source: 'web' | 'mcp'): ExternalTool {
  return {
    spec: { name, description: name, parameters: { type: 'object', properties: {} } },
    source:
      source === 'web'
        ? { kind: 'web' }
        : { kind: 'mcp', serverId: 's1', serverName: 'S1', toolName: name },
    summarize: () => `调用 ${name}`,
    preview: () => '预览内容',
    run: async () => ({ content: 'done', isError: false }),
  };
}

function externalModel(name: string): CallModel {
  let n = 0;
  return async () => {
    n += 1;
    if (n % 2 === 1) {
      return {
        blocks: [{ type: 'tool_use', id: `tu_${n}`, name, input: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    return { blocks: [{ type: 'text', text: '完成' }], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } };
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test('总是允许 MCP 工具：请求字段齐全；批准勾选 always 后写入 allowedMcpTools，再调用不再询问；清空后恢复询问', async () => {
  const h = await kernelHarness(externalModel('mcp__x'));
  h.kernel.tools.register({ toolsFor: async () => [externalTool('mcp__x', 'mcp')] });
  h.kernel.sendMessage(h.threadId, '一');
  await waitFor(() => requests(h).length === 1);
  const req = requests(h)[0]!;
  assert.equal(req.source, 'mcp');
  assert.equal(req.serverName, 'S1');
  assert.equal(req.alwaysKind, 'mcp_tool');
  assert.equal(req.canAlwaysAllow, true);
  assert.equal(req.tool, 'mcp__x');
  assert.equal(req.preview, '预览内容');

  assert.equal(h.kernel.respondApproval(req.id, true, true), true);
  await waitIdle(h, 1);
  let bot = (await h.kernel.state()).bots.find((b) => b.id === h.bot.id)!;
  for (let i = 0; i < 200 && !bot.allowedMcpTools.includes('s1/mcp__x'); i++) {
    await sleep(10);
    bot = (await h.kernel.state()).bots.find((b) => b.id === h.bot.id)!;
  }
  assert.deepEqual(bot.allowedMcpTools, ['s1/mcp__x']);

  h.kernel.sendMessage(h.threadId, '二');
  await waitIdle(h, 2);
  assert.equal(requests(h).length, 1);
  const log = h.kernel.approvalLog({ botId: h.bot.id });
  assert.equal(log[0]!.decidedBy, 'allowlist');
  assert.equal(log[0]!.result, 'approved');

  await h.kernel.updateBot(h.bot.id, { allowedMcpTools: [] });
  h.kernel.sendMessage(h.threadId, '三');
  await waitFor(() => requests(h).length === 2);
  h.kernel.respondApproval(requests(h)[1]!.id, false);
  await waitIdle(h, 3);
  await h.close();
});

test('总是允许联网：批准勾选 always 后 allowWeb 为 true，联网工具不再询问', async () => {
  const h = await kernelHarness(externalModel('web__fetch'));
  h.kernel.tools.register({ toolsFor: async () => [externalTool('web__fetch', 'web')] });
  h.kernel.sendMessage(h.threadId, '一');
  await waitFor(() => requests(h).length === 1);
  const req = requests(h)[0]!;
  assert.equal(req.source, 'web');
  assert.equal(req.alwaysKind, 'web');
  h.kernel.respondApproval(req.id, true, true);
  await waitIdle(h, 1);
  let bot = (await h.kernel.state()).bots.find((b) => b.id === h.bot.id)!;
  for (let i = 0; i < 200 && !bot.allowWeb; i++) {
    await sleep(10);
    bot = (await h.kernel.state()).bots.find((b) => b.id === h.bot.id)!;
  }
  assert.equal(bot.allowWeb, true);

  h.kernel.sendMessage(h.threadId, '二');
  await waitIdle(h, 2);
  assert.equal(requests(h).length, 1);
  await h.close();
});
