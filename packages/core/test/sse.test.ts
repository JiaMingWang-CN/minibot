import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSse, type SseEvent } from '../src/model/sse.ts';
import { newToolUseId } from '../src/model/ids.ts';
import { ResultAccumulator } from '../src/model/accumulator.ts';

async function* chunks(parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield Buffer.from(part);
}

async function collect(iter: AsyncIterable<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

test('一行被拆进两个 chunk、CRLF、多行 data、注释行', async () => {
  const ev = await collect(
    parseSse(chunks(['event: a\r\nda', 'ta: x\r\ndata: y\r\n\r\n: ping\n\ndata: z\n\n'])),
  );
  assert.deepEqual(ev, [
    { event: 'a', data: 'x\ny' },
    { event: null, data: 'z' },
  ]);
});

test('UTF-8 多字节字符被拆开', async () => {
  const text = Buffer.from('data: 中\n\n');
  const at = text.indexOf(Buffer.from('中')) + 1;
  async function* split(): AsyncGenerator<Uint8Array> {
    yield text.subarray(0, at);
    yield text.subarray(at);
  }
  const ev = await collect(parseSse(split()));
  assert.deepEqual(ev, [{ event: null, data: '中' }]);
});

test('ID 字符集', () => {
  assert.match(newToolUseId(), /^tu_[A-Za-z0-9]{24}$/);
});

test('snapshot 丢弃参数 JSON 不完整的 tool_use', () => {
  const acc = new ResultAccumulator(() => {});
  acc.toolStart('0', 'read_file');
  acc.toolArgs('0', '{"pa');
  assert.deepEqual(acc.snapshot(), []);
  assert.deepEqual(acc.result().blocks, []);
});

test('tool_use 用 minibot 自己生成的 id', () => {
  const acc = new ResultAccumulator(() => {});
  acc.toolStart('0', 'read_file');
  acc.toolArgs('0', '{"path":"a.txt"}');
  const block = acc.result().blocks[0];
  assert.equal(block?.type, 'tool_use');
  assert.match((block as { id: string }).id, /^tu_/);
});

test('相邻文本合并为一个块', () => {
  const deltas: string[] = [];
  const acc = new ResultAccumulator((d) => deltas.push(d.text));
  acc.text('a');
  acc.text('b');
  assert.deepEqual(acc.snapshot(), [{ type: 'text', text: 'ab' }]);
  assert.deepEqual(deltas, ['a', 'b']);
});

test('工具调用与文本保持流式顺序，opaque 附到最后一段推理', () => {
  const acc = new ResultAccumulator(() => {});
  acc.text('先');
  acc.toolStart('i0', 'read_file');
  acc.toolArgs('i0', '{"path":"a"}');
  acc.reasoning('想');
  acc.reasoningOpaque({ format: 'anthropic_messages', model: 'm', data: { signature: 's' } });
  const blocks = acc.snapshot();
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'tool_use', 'reasoning']);
  assert.deepEqual(blocks[2]?.opaque, {
    format: 'anthropic_messages',
    model: 'm',
    data: { signature: 's' },
  });
});

test('stop 与 usage 进入结果', () => {
  const acc = new ResultAccumulator(() => {});
  acc.text('x');
  acc.stop('tool_use');
  acc.usage({ inputTokens: 12 });
  acc.usage({ outputTokens: 5 });
  const result = acc.result();
  assert.equal(result.stopReason, 'tool_use');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 5 });
});
