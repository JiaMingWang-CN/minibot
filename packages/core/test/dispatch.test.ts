import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchApi, REMOTE_FORBIDDEN, type ApiRequest } from '../src/server/dispatch.ts';
import { kernelHarness, waitIdle } from './kernel-harness.ts';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function req(method: string, path: string, body?: unknown): ApiRequest {
  return {
    method,
    url: new URL(path, 'http://x'),
    readBody: async () => body,
  };
}

test('dispatch 附件', async () => {
  const h = await kernelHarness();
  try {
    h.kernel.sendMessage(h.threadId, '图', [{ mediaType: 'image/png', data: PNG }]);
    await waitIdle(h);
    const messages = h.kernel.listMessages(h.threadId);
    const image = messages[0]!.blocks.find((b) => b.type === 'image') as { id: string };
    const res = await dispatchApi(h.kernel, req('GET', `/api/attachments/${image.id}`));
    assert.equal(res.status, 200);
    assert.ok('bytes' in res);
    assert.equal(res.contentType, 'image/png');
    assert.ok(res.bytes.length > 0);
  } finally {
    await h.close();
  }
});

test('dispatch 错误转换', async () => {
  const h = await kernelHarness();
  try {
    const res = await dispatchApi(h.kernel, req('PATCH', '/api/threads/nope', { title: 'x' }));
    assert.equal(res.status, 404);
    assert.ok('json' in res);
    assert.equal((res.json as { error: { code: string } }).error.code, 'not_found');
  } finally {
    await h.close();
  }
});

test('state 不含 Key', async () => {
  const h = await kernelHarness();
  try {
    const res = await dispatchApi(h.kernel, req('GET', '/api/state'));
    assert.equal(res.status, 200);
    assert.ok('json' in res);
    assert.ok(!JSON.stringify(res.json).includes('sk-harness-secret-123'));
  } finally {
    await h.close();
  }
});

test('REMOTE_FORBIDDEN 形状', () => {
  assert.equal(REMOTE_FORBIDDEN.status, 403);
  assert.ok('json' in REMOTE_FORBIDDEN);
  assert.equal((REMOTE_FORBIDDEN.json as { error: { code: string } }).error.code, 'remote_forbidden');
});
