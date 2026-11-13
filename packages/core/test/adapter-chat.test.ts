import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { chatCompletionsAdapter } from '../src/model/chat-completions.ts';
import { parseSse } from '../src/model/sse.ts';
import { ResultAccumulator } from '../src/model/accumulator.ts';
import { historyForModel } from '../src/model/adapter.ts';
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

async function* chunks(parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield Buffer.from(part);
}

async function runFixture(name: string): Promise<ReturnType<ResultAccumulator['result']>> {
  const text = await fs.readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  const acc = new ResultAccumulator(() => {});
  await chatCompletionsAdapter.parse(parseSse(chunks([text])), acc, 'm');
  return acc.result();
}

function bodyOf(messages: StoredMessage[], over: Partial<ModelRequest> = {}): Record<string, unknown> {
  return chatCompletionsAdapter.body(req(messages, over)) as Record<string, unknown>;
}

test('请求体映射', () => {
  const b = bodyOf([
    user('读一下'),
    assistant([{ type: 'tool_use', id: 'tu_A', name: 'read_file', input: { path: 'a' } }]),
    toolResults([['tu_A', '内容']]),
    user('继续'),
  ]);
  const messages = b['messages'] as Record<string, unknown>[];
  assert.deepEqual(messages[0], { role: 'system', content: 'SYS' });
  assert.deepEqual((messages[2] as { tool_calls: unknown[] }).tool_calls[0], {
    id: 'tu_A',
    type: 'function',
    function: { name: 'read_file', arguments: '{"path":"a"}' },
  });
  assert.deepEqual(messages[3], { role: 'tool', tool_call_id: 'tu_A', content: '内容' });
  assert.equal(b['stream'], true);
  assert.deepEqual(b['stream_options'], { include_usage: true });
  assert.equal('max_tokens' in b, false);
});

test('reasoning_content 只回传给同格式同模型', () => {
  const messages = [
    user('hi'),
    assistant([
      {
        type: 'reasoning',
        text: 'r',
        opaque: { format: 'chat_completions', model: 'm', data: { reasoning_content: 'rc' } },
      },
      { type: 'text', text: 'x' },
    ]),
  ];
  const same = bodyOf(messages);
  assert.equal((same['messages'] as Record<string, unknown>[])[2]!['reasoning_content'], 'rc');
  const other = bodyOf(messages, { model: 'other' });
  assert.equal('reasoning_content' in (other['messages'] as Record<string, unknown>[])[2]!, false);
});

test('思考档位：null 不传任何字段；"high" → reasoning_effort "high"；"off" → thinking {type:"disabled"} 且无 reasoning_effort', () => {
  const none = bodyOf([user('hi')]);
  assert.equal('reasoning_effort' in none, false);
  assert.equal('thinking' in none, false);
  const high = bodyOf([user('hi')], { thinkingLevel: 'high' });
  assert.equal(high['reasoning_effort'], 'high');
  assert.equal('thinking' in high, false);
  const off = bodyOf([user('hi')], { thinkingLevel: 'off' });
  assert.deepEqual(off['thinking'], { type: 'disabled' });
  assert.equal('reasoning_effort' in off, false);
});

test('解析：文本、reasoning_content、分片的 tool_calls、usage、[DONE]', async () => {
  const result = await runFixture('chat-tools.sse');
  assert.deepEqual(result.blocks.map((b) => b.type), ['reasoning', 'text', 'tool_use']);
  const toolUse = result.blocks[2] as Extract<Block, { type: 'tool_use' }>;
  assert.equal(toolUse.name, 'read_file');
  assert.deepEqual(toolUse.input, { path: 'a.txt' });
  assert.equal(result.stopReason, 'tool_use');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 5 });
});

test('解析：reasoning_content 记入 opaque，下一轮能原样回传', async () => {
  const result = await runFixture('chat-tools.sse');
  const reasoning = result.blocks[0] as Extract<Block, { type: 'reasoning' }>;
  assert.equal(reasoning.opaque?.format, 'chat_completions');
  assert.equal(reasoning.opaque?.model, 'm');
  const b = bodyOf([user('hi'), assistant(result.blocks)]);
  const sent = (b['messages'] as Record<string, unknown>[])[2]!;
  assert.equal(sent['reasoning_content'], reasoning.text);
});

test('解析：没有结束标记就断开 → 抛 stream 错误并带上已收到的内容', async () => {
  const acc = new ResultAccumulator(() => {});
  const cut = 'data: {"choices":[{"delta":{"content":"半截"}}]}\n\n';
  await assert.rejects(
    chatCompletionsAdapter.parse(parseSse(chunks([cut])), acc, 'm'),
    (err: unknown) => (err as { kind?: string }).kind === 'stream',
  );
  assert.deepEqual(acc.result().blocks, [{ type: 'text', text: '半截' }]);
});

test('finish_reason length → max_tokens', async () => {
  const result = await runFixture('chat-length.sse');
  assert.equal(result.stopReason, 'max_tokens');
  assert.deepEqual(result.blocks, [{ type: 'text', text: '很长的回答' }]);
});

test('notice 消息不发给模型', () => {
  const notice: StoredMessage = {
    id: nextId++,
    threadId: 't',
    role: 'user',
    blocks: [{ type: 'text', text: '提示' }],
    kind: 'notice',
    interrupted: false,
    createdAt: 0,
  };
  const emptyAssistant: StoredMessage = {
    id: nextId++,
    threadId: 't',
    role: 'assistant',
    blocks: [],
    kind: null,
    interrupted: false,
    createdAt: 0,
  };
  assert.deepEqual(historyForModel([user('hi'), emptyAssistant, notice]).map((m) => m.role), ['user']);
});

test('skill 块作为用户文本发送：以「已加载 skill：」开头', () => {
  const msg: StoredMessage = {
    id: nextId++, threadId: 't', role: 'user', kind: null, interrupted: false, createdAt: 0,
    blocks: [
      { type: 'skill', name: 'pdf-tools', text: 'skill 目录：/x\n\n正文' },
      { type: 'text', text: '帮我处理' },
    ],
  };
  const body = bodyOf([msg]);
  const messages = body['messages'] as { role: string; content: unknown }[];
  const user = messages.find((m) => m.role === 'user')!;
  assert.equal(typeof user.content, 'string');
  assert.ok((user.content as string).startsWith('已加载 skill：pdf-tools'));
  assert.ok((user.content as string).includes('正文'));
  assert.ok((user.content as string).includes('帮我处理'));
});
