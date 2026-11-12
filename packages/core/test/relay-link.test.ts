import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { RelayLink, type RelayLinkState } from '../src/remote/relay-link.ts';
import { generateKeyPair } from '../src/remote/noise.ts';
import { startRelay } from '../../relay/src/relay.ts';
import { waitFor } from './kernel-harness.ts';

const TOKEN = 'relay-link-test-token';

test('relay-link 半开连接：收不到 pong 就断开重连', async () => {
  // 假中继：回 welcome，但不自动回 pong，模拟对端已经消失的半开连接
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: false });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  let connections = 0;
  wss.on('connection', (ws) => {
    connections += 1;
    ws.once('message', () => ws.send(JSON.stringify({ type: 'welcome' })));
  });
  const states: RelayLinkState[] = [];
  const link = new RelayLink({
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    token: 'x'.repeat(20),
    identity: generateKeyPair(),
    accept: () => {},
    onState: (state) => states.push(state),
    initialBackoffMs: 20,
    pingIntervalMs: 40,
  });
  try {
    link.start();
    await waitFor(() => states.includes('connected'));
    await waitFor(() => connections >= 2, 3000);
    assert.ok(states.lastIndexOf('error') > states.indexOf('connected'));
  } finally {
    link.stop();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});

test('relay-link 用私钥通过中继的身份挑战', async () => {
  const relay = await startRelay({ host: '127.0.0.1', port: 0, token: TOKEN });
  const states: RelayLinkState[] = [];
  const link = new RelayLink({
    url: `ws://127.0.0.1:${relay.port}/v1`,
    token: TOKEN,
    identity: generateKeyPair(),
    accept: () => {},
    onState: (state) => states.push(state),
  });
  try {
    link.start();
    await waitFor(() => states.includes('connected'));
  } finally {
    link.stop();
    await relay.close();
  }
});

test('relay-link 被同一身份顶替后退避重连，不永久停止', async () => {
  const relay = await startRelay({ host: '127.0.0.1', port: 0, token: TOKEN });
  const identity = generateKeyPair();
  const make = (states: RelayLinkState[]) =>
    new RelayLink({
      url: `ws://127.0.0.1:${relay.port}/v1`,
      token: TOKEN,
      identity,
      accept: () => {},
      onState: (state) => states.push(state),
      initialBackoffMs: 30,
    });
  const first: RelayLinkState[] = [];
  const second: RelayLinkState[] = [];
  const a = make(first);
  const b = make(second);
  try {
    a.start();
    await waitFor(() => first.includes('connected'));
    b.start();
    await waitFor(() => second.includes('connected'));
    await waitFor(() => first.includes('error'));
    b.stop();
    // 顶替者走了，原来的电脑自己连回来
    await waitFor(() => first.lastIndexOf('connected') > first.indexOf('error'), 3000);
    assert.equal(a.isStopped(), false);
  } finally {
    a.stop();
    b.stop();
    await relay.close();
  }
});
