import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { responsesAdapter } from '../src/model/responses.ts';
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

function toolResults(items: [string, string][]): StoredMessage {
  return {
    id: nextId++,
    threadId: 't',
    role: 'user',
    blocks: items.map(([toolUseId, content]) => ({
      type: 'tool_result',
      toolUseId,
      content,
      status: 'ok',
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
  return responsesAdapter.body(req(messages, over)) as Record<string, unknown>;
}

async function* chunks(parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield Buffer.from(part);
}

async function runFixture(name: string): Promise<ReturnType<ResultAccumulator['result']>> {
  const text = await fs.readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  const acc = new ResultAccumulator(() => {});
  await responsesAdapter.parse(parseSse(chunks([text])), acc, 'm');
  return acc.result();
}

test('无状态请求体', () => {
  const b = bodyOf([user('hi')]);
  assert.equal(b['store'], false);
  assert.equal(b['instructions'], 'SYS');
  assert.equal('previous_response_id' in b, false);
  assert.deepEqual(b['include'], ['reasoning.encrypted_content']);
  assert.deepEqual((b['input'] as Record<string, unknown>[])[0], {
    role: 'user',
    content: [{ type: 'input_text', text: 'hi' }],
  });
  assert.equal((b['tools'] as Record<string, unknown>[])[0]!['type'], 'function');
});

test('思考档位："medium" → reasoning {effort:"medium"}；"off" → thinking {type:"disabled"} 且无 reasoning；null 两者都不传', () => {
  const none = bodyOf([user('hi')]);
  assert.equal('reasoning' in none, false);
  assert.equal('thinking' in none, false);
  const medium = bodyOf([user('hi')], { thinkingLevel: 'medium' });
  assert.deepEqual(medium['reasoning'], { effort: 'medium' });
  assert.equal('thinking' in medium, false);
  const off = bodyOf([user('hi')], { thinkingLevel: 'off' });
  assert.deepEqual(off['thinking'], { type: 'disabled' });
  assert.equal('reasoning' in off, false);
});

test('tool_use / tool_result 映射为 function_call / function_call_output', () => {
  const b = bodyOf([
    user('a'),
    assistant([{ type: 'tool_use', id: 'tu_A', name: 'read_file', input: { path: 'a' } }]),
    toolResults([['tu_A', '内容']]),
  ]);
  const input = b['input'] as Record<string, unknown>[];
  const call = input.find((i) => i['type'] === 'function_call');
  assert.deepEqual(call, {
    type: 'function_call',
    call_id: 'tu_A',
    name: 'read_file',
    arguments: '{"path":"a"}',
  });
  const output = input.find((i) => i['type'] === 'function_call_output');
  assert.deepEqual(output, { type: 'function_call_output', call_id: 'tu_A', output: '内容' });
});

test('加密 reasoning 只回传给同格式同模型', () => {
  const item = { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' };
  const messages = [
    user('hi'),
    assistant([
      {
        type: 'reasoning',
        text: '',
        opaque: { format: 'responses', model: 'm', data: item },
      },
      { type: 'text', text: 'x' },
    ]),
  ];
  const same = bodyOf(messages);
  const sameInput = same['input'] as Record<string, unknown>[];
  assert.ok(sameInput.some((i) => i['type'] === 'reasoning' && i['encrypted_content'] === 'enc'));
  const other = bodyOf(messages, { model: 'other' });
  const otherInput = other['input'] as Record<string, unknown>[];
  assert.equal(otherInput.some((i) => i['type'] === 'reasoning'), false);
});

test('解析：output_text.delta、output_item.added(function_call)、function_call_arguments.delta、reasoning item done、completed usage', async () => {
  const result = await runFixture('responses-tools.sse');
  assert.deepEqual(result.blocks.map((b) => b.type), ['reasoning', 'text', 'tool_use']);
  const reasoning = result.blocks[0] as Extract<Block, { type: 'reasoning' }>;
  assert.equal(reasoning.text, '思考');
  assert.equal((reasoning.opaque?.data as { encrypted_content?: string }).encrypted_content, 'enc_abc');
  const toolUse = result.blocks[2] as Extract<Block, { type: 'tool_use' }>;
  assert.equal(toolUse.name, 'read_file');
  assert.deepEqual(toolUse.input, { path: 'a.txt' });
  assert.equal(result.stopReason, 'tool_use');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 5 });
});

test('response.failed 抛 ModelError(kind "stream")', async () => {
  const text = await fs.readFile(new URL('./fixtures/responses-failed.sse', import.meta.url), 'utf8');
  const acc = new ResultAccumulator(() => {});
  await assert.rejects(responsesAdapter.parse(parseSse(chunks([text])), acc, 'm'), (err: unknown) => {
    assert.ok(err instanceof ModelError);
    assert.equal(err.kind, 'stream');
    assert.match(err.message, /服务端错误/);
    assert.deepEqual(err.partial, [{ type: 'text', text: '部分' }]);
    return true;
  });
});

test('response.incomplete(max_output_tokens) → max_tokens', async () => {
  const result = await runFixture('responses-incomplete.sse');
  assert.equal(result.stopReason, 'max_tokens');
  assert.deepEqual(result.blocks, [{ type: 'text', text: '截断' }]);
});

test('skill 块作为用户文本发送：以「已加载 skill：」开头', () => {
  const msg: StoredMessage = {
    id: 9991, threadId: 't', role: 'user', kind: null, interrupted: false, createdAt: 0,
    blocks: [{ type: 'skill', name: 'pdf-tools', text: 'skill 目录：/x\n\n正文' }],
  };
  const body = bodyOf([msg]);
  const input = body['input'] as { role?: string; content?: { type: string; text?: string }[] }[];
  const user = input.find((m) => m.role === 'user')!;
  const text = (user.content ?? []).map((c) => c.text ?? '').join('');
  assert.ok(text.startsWith('已加载 skill：pdf-tools'));
});
