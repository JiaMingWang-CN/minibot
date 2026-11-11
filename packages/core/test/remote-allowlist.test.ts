import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRemoteAllowed } from '../src/remote/allowlist.ts';

test('allowlist 放行', () => {
  const allowed: [string, string][] = [
    ['GET', '/api/state'],
    ['GET', '/api/running'],
    ['GET', '/api/approvals'],
    ['GET', '/api/search'],
    ['GET', '/api/bots/b1/threads'],
    ['GET', '/api/threads/t1/messages'],
    ['GET', '/api/threads/t1'],
    ['GET', '/api/threads/t1/usage'],
    ['GET', '/api/attachments/a1'],
    ['POST', '/api/bots/b1/threads'],
    ['POST', '/api/threads/t1/messages'],
    ['PATCH', '/api/threads/t1'],
    ['DELETE', '/api/threads/t1'],
    ['POST', '/api/threads/t1/retry'],
  ];
  for (const [method, p] of allowed) assert.equal(isRemoteAllowed(method, p), true, `${method} ${p}`);
});

test('allowlist 拒绝', () => {
  const denied: [string, string][] = [
    ['PUT', '/api/settings'],
    ['POST', '/api/providers'],
    ['POST', '/api/onboarding'],
    ['PUT', '/api/memory/file'],
    ['GET', '/api/memory/file'],
    ['PATCH', '/api/bots/b1'],
    ['GET', '/api/presets'],
    ['GET', '/api/approvals/log'],
    ['POST', '/api/threads/t1/compact'],
    ['GET', '/api/threads/t1/context'],
    ['POST', '/api/memory/revisions/r1/revert'],
    ['GET', '/api/remote'],
  ];
  for (const [method, p] of denied) assert.equal(isRemoteAllowed(method, p), false, `${method} ${p}`);
});

test('allowlist 多段', () => {
  assert.equal(isRemoteAllowed('GET', '/api/threads/a/b/messages'), false);
});
