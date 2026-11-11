import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { KernelError } from '../src/kernel.ts';
import { chatCompletionsAdapter } from '../src/model/chat-completions.ts';
import { responsesAdapter } from '../src/model/responses.ts';
import { anthropicAdapter } from '../src/model/anthropic.ts';
import type { ModelRequest } from '../src/model/adapter.ts';
import type { Block, StoredMessage } from '../src/model/types.ts';
import { ModelError } from '../src/model/types.ts';
import { transcriptOf } from '../src/agent/transcript.ts';
import { kernelHarness, waitIdle } from './kernel-harness.ts';

// 1x1 透明 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function userWithImage(): StoredMessage {
  return {
    id: 1,
    threadId: 't',
    role: 'user',
    blocks: [
      { type: 'text', text: '看图' },
      { type: 'image', id: 'img1', mediaType: 'image/png' },
    ],
    kind: null,
    interrupted: false,
    createdAt: 0,
  };
}

function request(attachments: Record<string, string>): ModelRequest {
  return {
    model: 'm',
    system: 's',
    messages: [userWithImage()],
    tools: [],
    maxTokens: 100,
    thinkingLevel: null,
    attachments,
  };
}

test('图片：Chat Completions 用 content 数组和 data URL', () => {
  const body = chatCompletionsAdapter.body(request({ img1: PNG })) as { messages: Record<string, unknown>[] };
  assert.deepEqual(body.messages[1], {
    role: 'user',
    content: [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
    ],
  });
});

test('图片：Responses 用 input_image', () => {
  const body = responsesAdapter.body(request({ img1: PNG })) as { input: Record<string, unknown>[] };
  assert.deepEqual(body.input[0], {
    role: 'user',
    content: [
      { type: 'input_text', text: '看图' },
      { type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
    ],
  });
});

test('图片：Anthropic 用 base64 image source', () => {
  const body = anthropicAdapter.body(request({ img1: PNG })) as {
    messages: { content: Record<string, unknown>[] }[];
  };
  assert.deepEqual(body.messages[0]!.content, [
    { type: 'text', text: '看图' },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG },
      cache_control: { type: 'ephemeral' },
    },
  ]);
});

test('图片：文件丢失时改成文字占位；对话记录里写作【图片】', () => {
  const body = chatCompletionsAdapter.body(request({})) as { messages: Record<string, unknown>[] };
  assert.deepEqual(body.messages[1], {
    role: 'user',
    content: [
      { type: 'text', text: '看图' },
      { type: 'text', text: '[图片已丢失]' },
    ],
  });
  assert.match(transcriptOf([userWithImage()]), /【图片】/);
});

test('图片：sendMessage 存文件、消息里只存引用，模型请求带上图片数据；删除线程时删文件', async () => {
  const seen: ModelRequest[] = [];
  const h = await kernelHarness(async ({ request: r }) => {
    seen.push(r);
    return { blocks: [{ type: 'text', text: '是个像素' }], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } };
  });
  h.kernel.sendMessage(h.threadId, '这是什么', [{ mediaType: 'image/png', data: PNG }]);
  await waitIdle(h);
  const user = h.kernel.listMessages(h.threadId)[0]!;
  const image = user.blocks.find((b): b is Extract<Block, { type: 'image' }> => b.type === 'image')!;
  assert.equal(image.mediaType, 'image/png');
  assert.equal(JSON.stringify(user.blocks).includes(PNG), false);
  assert.equal(seen[0]!.attachments?.[image.id], PNG);
  const file = await h.kernel.readAttachment(image.id);
  assert.equal(file.mediaType, 'image/png');
  assert.equal(file.data.toString('base64'), PNG);

  const dir = path.join(h.root, 'attachments');
  assert.equal((await fs.readdir(dir)).length, 1);
  await h.kernel.deleteThread(h.threadId);
  assert.equal((await fs.readdir(dir)).length, 0);
  await assert.rejects(h.kernel.readAttachment(image.id), (e) => e instanceof KernelError && e.code === 'not_found');
  await h.close();
});

test('图片：校验类型、数量、大小与 id 格式', async () => {
  const h = await kernelHarness();
  const bad = (e: unknown): boolean => e instanceof KernelError && e.code === 'invalid';
  assert.throws(() => h.kernel.sendMessage(h.threadId, 'x', [{ mediaType: 'image/bmp', data: PNG }]), bad);
  assert.throws(
    () => h.kernel.sendMessage(h.threadId, 'x', Array.from({ length: 5 }, () => ({ mediaType: 'image/png', data: PNG }))),
    bad,
  );
  const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
  assert.throws(() => h.kernel.sendMessage(h.threadId, 'x', [{ mediaType: 'image/png', data: big }]), bad);
  assert.throws(() => h.kernel.sendMessage(h.threadId, 'x', [{ mediaType: 'image/png', data: '' }]), bad);
  assert.throws(() => h.kernel.sendMessage(h.threadId, '', []), bad);
  await assert.rejects(h.kernel.readAttachment('../secrets'), bad);
  await h.close();
});

test('图片：带图请求被拒（400）时提示模型可能不支持图片', async () => {
  const h = await kernelHarness(async () => {
    throw new ModelError('bad_request', 'image_url is not supported');
  });
  h.kernel.sendMessage(h.threadId, '看图', [{ mediaType: 'image/png', data: PNG }]);
  await waitIdle(h);
  const last = h.kernel.listMessages(h.threadId).at(-1)!;
  const text = (last.blocks[0] as { text: string }).text;
  assert.match(text, /可能不支持图片/);
  await h.close();
});
