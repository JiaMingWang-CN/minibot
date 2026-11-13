import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, decideExternal, type ToolName } from '../src/approval/policy.ts';
import { ApprovalBroker, type ApprovalEvent } from '../src/approval/broker.ts';
import type { PathClass } from '../src/tools/path-guard.ts';

const cases: [('ask' | 'auto'), ToolName, PathClass[], 'allow' | 'ask'][] = [
  ['ask', 'read_file', ['workspace'], 'allow'],
  ['ask', 'glob', ['workspace'], 'allow'],
  ['ask', 'read_file', ['outside'], 'ask'],
  ['ask', 'write_file', ['workspace'], 'ask'],
  ['ask', 'run_command', [], 'ask'],
  ['ask', 'edit_file', ['own_memory'], 'allow'],
  ['auto', 'run_command', [], 'allow'],
  ['auto', 'write_file', ['outside'], 'allow'],
  ['auto', 'read_file', ['sensitive'], 'ask'],
  ['ask', 'read_file', ['own_memory'], 'allow'],
];

test('审批矩阵（spec §8.1）', () => {
  for (const [mode, tool, classes, expected] of cases) {
    assert.equal(decide(mode, tool, classes), expected, `${mode} ${tool} ${classes}`);
  }
});

test('外部工具审批矩阵：web 只 ask 档问；mcp 除 auto 外都要问', () => {
  const matrix: [('ask' | 'edits' | 'auto'), 'web' | 'mcp', 'allow' | 'ask'][] = [
    ['ask', 'web', 'ask'],
    ['edits', 'web', 'allow'],
    ['auto', 'web', 'allow'],
    ['ask', 'mcp', 'ask'],
    ['edits', 'mcp', 'ask'],
    ['auto', 'mcp', 'allow'],
  ];
  for (const [mode, kind, expected] of matrix) {
    assert.equal(decideExternal(mode, kind), expected, `${mode} ${kind}`);
  }
});

test('broker：respond 后 resolve，并发出 resolved 事件', async () => {
  const events: ApprovalEvent[] = [];
  const broker = new ApprovalBroker((e) => events.push(e));
  const promise = broker.request(
    { botId: 'b1', threadId: 't1', tool: 'write_file', summary: '写文件 a.txt' },
    new AbortController().signal,
  );
  const request = broker.pending()[0]!;
  assert.equal(request.botId, 'b1');
  assert.equal(request.threadId, 't1');
  assert.ok(events.some((e) => e.type === 'approval_request'));
  assert.equal(broker.respond(request.id, true), true);
  assert.equal(await promise, 'approved');
  assert.deepEqual(
    events.map((e) => e.type),
    ['approval_request', 'approval_resolved'],
  );
  assert.equal((events[1] as { result: string }).result, 'approved');
  assert.equal(broker.pending().length, 0);
});

test('broker：signal 中止 → cancelled，pending 中移除', async () => {
  const events: ApprovalEvent[] = [];
  const broker = new ApprovalBroker((e) => events.push(e));
  const controller = new AbortController();
  const promise = broker.request(
    { botId: 'b1', threadId: 't1', tool: 'run_command', summary: 'rm -rf' },
    controller.signal,
  );
  assert.equal(broker.pending().length, 1);
  controller.abort();
  assert.equal(await promise, 'cancelled');
  assert.equal(broker.pending().length, 0);
  assert.equal(
    (events[events.length - 1] as { result: string }).result,
    'cancelled',
  );
});

test('broker：重复 respond 返回 false', async () => {
  const broker = new ApprovalBroker(() => {});
  const promise = broker.request(
    { botId: 'b1', threadId: 't1', tool: 'run_command', summary: 'ls' },
    new AbortController().signal,
  );
  const id = broker.pending()[0]!.id;
  assert.equal(broker.respond(id, true), true);
  assert.equal(await promise, 'approved');
  assert.equal(broker.respond(id, true), false);
});
