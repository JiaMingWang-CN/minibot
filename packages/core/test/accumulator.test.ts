import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResultAccumulator } from '../src/model/accumulator.ts';

const opaque = (n: number) => ({ format: 'responses' as const, model: 'm', data: { n } });

test('reasoningOpaque：多个没有摘要文字的推理项各自保留自己的密文', () => {
  const acc = new ResultAccumulator(() => {});
  acc.reasoningOpaque(opaque(1));
  acc.reasoningOpaque(opaque(2));
  const blocks = acc.snapshot().filter((b) => b.type === 'reasoning');
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => (b as { opaque?: { data: unknown } }).opaque?.data), [{ n: 1 }, { n: 2 }]);
});

test('reasoningOpaque：带签名的 thinking 后面跟 redacted_thinking，签名不被冲掉', () => {
  const acc = new ResultAccumulator(() => {});
  acc.reasoning('思考');
  acc.reasoningOpaque({ format: 'anthropic_messages', model: 'm', data: { signature: 'sig' } });
  acc.reasoningOpaque({ format: 'anthropic_messages', model: 'm', data: { redacted: 'x' } });
  const blocks = acc.snapshot();
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.type === 'reasoning' && blocks[0]!.text, '思考');
  assert.deepEqual((blocks[0] as { opaque?: { data: unknown } }).opaque?.data, { signature: 'sig' });
  assert.deepEqual((blocks[1] as { opaque?: { data: unknown } }).opaque?.data, { redacted: 'x' });
});

test('已挂 opaque 的推理块之后的新推理文字另起一块', () => {
  const acc = new ResultAccumulator(() => {});
  acc.reasoningOpaque(opaque(1));
  acc.reasoning('第二项摘要');
  acc.reasoningOpaque(opaque(2));
  const blocks = acc.snapshot();
  assert.equal(blocks.length, 2);
  assert.equal((blocks[0] as { text: string }).text, '');
  assert.equal((blocks[1] as { text: string }).text, '第二项摘要');
});

test('工具参数：分块到达，取结果时才解析；空参数按 {}；解析不出对象的丢弃', () => {
  const acc = new ResultAccumulator(() => {});
  acc.toolStart('a', 'read_file');
  acc.toolArgs('a', '{"path":');
  assert.equal(acc.snapshot().length, 0);
  acc.toolArgs('a', '"x.txt"}');
  acc.toolStart('b', 'noargs');
  acc.toolStart('c', 'broken');
  acc.toolArgs('c', '[1,2]');
  acc.toolStart('d', 'half');
  acc.toolArgs('d', '{"p":');
  const blocks = acc.snapshot();
  assert.deepEqual(
    blocks.map((b) => (b.type === 'tool_use' ? [b.name, b.input] : null)),
    [['read_file', { path: 'x.txt' }], ['noargs', {}]],
  );
});

test('工具参数：完整对象之后多出来的增量不破坏结果；toolArgsFull 替换而不是追加', () => {
  const acc = new ResultAccumulator(() => {});
  acc.toolStart('a', 'read_file');
  acc.toolArgs('a', '{"path":"a"}');
  acc.toolArgs('a', ' 多余');
  assert.deepEqual((acc.snapshot()[0] as { input: unknown }).input, { path: 'a' });

  const full = new ResultAccumulator(() => {});
  full.toolStart('a', 'read_file');
  full.toolArgs('a', '{"path":');
  full.toolArgs('a', '"a"}');
  full.toolArgsFull('a', '{"path":"a"}');
  assert.deepEqual((full.snapshot()[0] as { input: unknown }).input, { path: 'a' });
});

test('工具参数：几万个增量也很快（不是平方复杂度）', () => {
  const acc = new ResultAccumulator(() => {});
  acc.toolStart('a', 'write_file');
  acc.toolArgs('a', '{"content":"');
  const started = Date.now();
  for (let i = 0; i < 50_000; i++) acc.toolArgs('a', 'x'.repeat(100));
  acc.toolArgs('a', '"}');
  const input = (acc.snapshot()[0] as { input: { content: string } }).input;
  assert.equal(input.content.length, 5_000_000);
  assert.ok(Date.now() - started < 3000);
});
