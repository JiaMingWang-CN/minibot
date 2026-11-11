import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { anthropicAdapter } from '../src/model/anthropic.ts';
import { parseSse } from '../src/model/sse.ts';
import { ResultAccumulator } from '../src/model/accumulator.ts';
import { ModelError } from '../src/model/types.ts';
import type { Block, StoredMessage } from '../src/model/types.ts';
import type { ModelRequest } from '../src/model/adapter.ts';

let nextId = 1;

function user(text: string): StoredMessage {
  return {
    id: nextId++,
    threadId: 't',
    role: 'user',
    blocks: [{ type: 'text', text }],
    kind: null,
    interrupted: false,
    createdAt: 0,
  };
}

function assistant(blocks: Block[]): StoredMessage {
  return {
    id: nextId++,
    threadId: 't',
    role: 'assistant',
    blocks,
    kind: null,
    interrupted: false,
    createdAt: 0,
  };
}

function toolResults(items: [string, string, 'ok' | 'error' | 'denied' | 'cancelled'?][]): StoredMessage {
  return {
    id: nextId++,
    threadId: 't',
    role: 'user',
    blocks: items.map(([toolUseId, content, status]) => ({
      type: 'tool_result',
      toolUseId,
      content,
      status: status ?? 'ok',
    })),
    kind: null,
    interrupted: false,
    createdAt: 0,
  };
}

function req(messages: StoredMessage[], over: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'm',
    system: 'SYS',
    messages,
    tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object' } }],
    maxTokens: 128000,
    thinkingLevel: null,
    ...over,
  };
}

function bodyOf(messages: StoredMessage[], over: Partial<ModelRequest> = {}): Record<string, unknown> {
  return anthropicAdapter.body(req(messages, over)) as Record<string, unknown>;
}

async function* chunks(parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield Buffer.from(part);
}

async function runFixture(name: string): Promise<ReturnType<ResultAccumulator['result']>> {
  const text = await fs.readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  const acc = new ResultAccumulator(() => {});
  await anthropicAdapter.parse(parseSse(chunks([text])), acc, 'm');
  return acc.result();
}

test('请求体：system 字段、max_tokens、input_schema、tool_result.is_error', () => {
  const b = bodyOf(
    [
      user('a'),
      assistant([{ type: 'tool_use', id: 'tu_A', name: 'run_command', input: { command: 'ls' } }]),
      toolResults([['tu_A', '拒绝', 'denied']]),
    ],
    { maxTokens: 128000 },
  );
  assert.deepEqual(b['system'], [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
  assert.equal(b['max_tokens'], 128000);
  const messages = b['messages'] as { role: string; content: Record<string, unknown>[] }[];
  // 缓存断点只放在最后一条消息的最后一个块上
  assert.deepEqual(messages[2]!.content[0], {
    type: 'tool_result',
    tool_use_id: 'tu_A',
    content: '拒绝',
    is_error: true,
    cache_control: { type: 'ephemeral' },
  });
  assert.equal('cache_control' in messages[0]!.content[0]!, false);
  assert.ok((b['tools'] as Record<string, unknown>[])[0]!['input_schema']);
});

test('相邻的同角色消息合并', () => {
  const b = bodyOf([user('a'), user('b')]);
  assert.deepEqual(b['messages'], [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
      ],
    },
  ]);
});

test('思考档位："xhigh" → output_config {effort:"xhigh"}；"off" → thinking {type:"disabled"} 且无 output_config；null 两者都不传', () => {
  const none = bodyOf([user('hi')]);
  assert.equal('output_config' in none, false);
  assert.equal('thinking' in none, false);
  const xhigh = bodyOf([user('hi')], { thinkingLevel: 'xhigh' });
  assert.deepEqual(xhigh['output_config'], { effort: 'xhigh' });
  assert.equal('thinking' in xhigh, false);
  const off = bodyOf([user('hi')], { thinkingLevel: 'off' });
  assert.deepEqual(off['thinking'], { type: 'disabled' });
  assert.equal('output_config' in off, false);
});

test('thinking 与 signature 只回传给同格式同模型；redacted_thinking 原样回传', () => {
  const thinking: Block = {
    type: 'reasoning',
    text: '想',
    opaque: { format: 'anthropic_messages', model: 'm', data: { signature: 'sig' } },
  };
  const messages = [user('hi'), assistant([thinking, { type: 'text', text: 'x' }])];
  const same = bodyOf(messages);
  const sameMessages = same['messages'] as { content: Record<string, unknown>[] }[];
  assert.deepEqual(sameMessages[1]!.content[0], {
    type: 'thinking',
    thinking: '想',
    signature: 'sig',
  });
  const other = bodyOf(messages, { model: 'other' });
  const otherMessages = other['messages'] as { content: Record<string, unknown>[] }[];
  assert.equal(otherMessages[1]!.content[0]!['type'], 'text');

  const redacted: Block = {
    type: 'reasoning',
    text: '',
    opaque: { format: 'anthropic_messages', model: 'm', data: { redacted: 'enc' } },
  };
  const rb = bodyOf([user('hi'), assistant([redacted])]);
  assert.deepEqual((rb['messages'] as { content: Record<string, unknown>[] }[])[1]!.content[0], {
    type: 'redacted_thinking',
    data: 'enc',
  });
});

test('解析：thinking_delta + signature_delta、text_delta、input_json_delta、message_delta 的 stop_reason 与 usage', async () => {
  const result = await runFixture('anthropic-tools.sse');
  assert.deepEqual(result.blocks.map((b) => b.type), ['reasoning', 'text', 'tool_use']);
  const reasoning = result.blocks[0] as Extract<Block, { type: 'reasoning' }>;
  assert.equal(reasoning.text, '思考');
  assert.deepEqual(reasoning.opaque?.data, { signature: 'sig_abc' });
  const toolUse = result.blocks[2] as Extract<Block, { type: 'tool_use' }>;
  assert.equal(toolUse.name, 'read_file');
  assert.deepEqual(toolUse.input, { path: 'a.txt' });
  assert.equal(result.stopReason, 'tool_use');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 5 });
});

test('event: error 抛 ModelError(kind "stream")，partial 保留已收到的文本', async () => {
  const text = await fs.readFile(new URL('./fixtures/anthropic-error.sse', import.meta.url), 'utf8');
  const acc = new ResultAccumulator(() => {});
  await assert.rejects(anthropicAdapter.parse(parseSse(chunks([text])), acc, 'm'), (err: unknown) => {
    assert.ok(err instanceof ModelError);
    assert.equal(err.kind, 'stream');
    assert.match(err.message, /服务过载/);
    assert.deepEqual(err.partial, [{ type: 'text', text: '部分' }]);
    return true;
  });
});
