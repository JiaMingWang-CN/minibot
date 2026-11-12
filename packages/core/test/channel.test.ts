import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandshake, generateKeyPair } from '../src/remote/noise.ts';
import { FRAME_DATA, MAX_APP_MESSAGE_BYTES, SecureChannel } from '../src/remote/channel.ts';
import { carrierPair } from './carrier-pair.ts';
import { waitFor } from './kernel-harness.ts';

function channels() {
  const i = generateKeyPair();
  const r = generateKeyPair();
  const hi = createHandshake({ pattern: 'KK', initiator: true, s: i, rs: r.publicKey });
  const hr = createHandshake({ pattern: 'KK', initiator: false, s: r, rs: i.publicKey });
  hr.readMessage(hi.writeMessage(Buffer.alloc(0)));
  hi.readMessage(hr.writeMessage(Buffer.alloc(0)));
  const si = hi.split();
  const sr = hr.split();
  const { a, b } = carrierPair();
  const left = new SecureChannel(a, si.send, si.recv);
  const right = new SecureChannel(b, sr.send, sr.recv);
  return { a, b, left, right };
}

test('channel 往返', async () => {
  const { left, right } = channels();
  const got: unknown[] = [];
  right.onMessage((m) => got.push(m));
  left.send({ a: 1 });
  await waitFor(() => got.length === 1);
  assert.deepEqual(got[0], { a: 1 });
});

test('channel 大消息', async () => {
  const { a, left, right } = channels();
  const got: { blob: string }[] = [];
  right.onMessage((m) => got.push(m as { blob: string }));
  const blob = 'x'.repeat(30 * 1024 * 1024);
  left.send({ blob });
  await waitFor(() => got.length === 1, 20000);
  assert.equal(got[0]!.blob.length, blob.length);
  assert.ok(a.sent.length > 400);
  assert.ok(a.sent.every((f) => f.length <= 65536));
});

test('channel 超限', async () => {
  const { a, left, right } = channels();
  let closed = false;
  const got: unknown[] = [];
  right.onClose(() => (closed = true));
  right.onMessage((m) => got.push(m));
  // 发送端不设限，接收端累计超过上限即关闭
  left.send({ blob: 'x'.repeat(MAX_APP_MESSAGE_BYTES + 1024) });
  await waitFor(() => closed, 20000);
  assert.equal(got.length, 0);
  assert.ok(a.sent.length > 0);
});

test('channel 篡改', async () => {
  const { a, b, left, right } = channels();
  let closed = false;
  right.onClose(() => (closed = true));
  const original = a.send.bind(a);
  a.send = (frame: Buffer) => {
    const copy = Buffer.from(frame);
    copy[copy.length - 1]! ^= 1;
    original(copy);
  };
  left.send({ a: 1 });
  await waitFor(() => closed);
  assert.ok(b.sent.length === 0);
});

test('channel 重放', async () => {
  const { a, left, right } = channels();
  const got: unknown[] = [];
  let closed = false;
  right.onMessage((m) => got.push(m));
  right.onClose(() => (closed = true));
  left.send({ a: 1 });
  await waitFor(() => got.length === 1);
  const frame = a.sent[0]!;
  assert.equal(frame[0], FRAME_DATA);
  // 把同一帧再投递一次
  (a as unknown as { peer: { frameCb: (f: Buffer) => void } }).peer.frameCb(frame);
  await waitFor(() => closed);
  assert.equal(got.length, 1);
});

test('channel 积压', async () => {
  const { a, left } = channels();
  let backlog = 0;
  (a as { bufferedAmount?: () => number }).bufferedAmount = () => backlog;
  let closed = false;
  left.onClose(() => (closed = true));
  left.send({ a: 1 });
  assert.equal(closed, false);
  const sent = a.sent.length;
  backlog = 64 * 1024 * 1024;
  left.send({ a: 2 });
  assert.equal(closed, true);
  assert.equal(a.sent.length, sent);
});
