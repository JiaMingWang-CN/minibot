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

test('relay-link TCP 通但不回 WebSocket 升级：超时后报错并重连', async () => {
  const { createServer } = await import('node:net');
  let accepted = 0;
  const sockets: { destroy(): void }[] = [];
  const server = createServer((socket) => {
    accepted += 1;
    sockets.push(socket);
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const states: { state: RelayLinkState; error: string | null }[] = [];
  const link = new RelayLink({
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token: 'x'.repeat(20),
    identity: generateKeyPair(),
    accept: () => {},
    onState: (state, error) => states.push({ state, error }),
    initialBackoffMs: 20,
    connectTimeoutMs: 80,
  });
  try {
    link.start();
    await waitFor(() => states.some((s) => s.state === 'error'), 3000);
    assert.equal(states.find((s) => s.state === 'error')!.error, '连接中继超时');
    await waitFor(() => accepted >= 2, 3000);
  } finally {
    link.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('relay-link 升级成功但一直没有 welcome：超时后断开重连', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  let connections = 0;
  wss.on('connection', () => {
    connections += 1;
  });
  const states: { state: RelayLinkState; error: string | null }[] = [];
  const link = new RelayLink({
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    token: 'x'.repeat(20),
    identity: generateKeyPair(),
    accept: () => {},
    onState: (state, error) => states.push({ state, error }),
    initialBackoffMs: 20,
    connectTimeoutMs: 80,
  });
  try {
    link.start();
    await waitFor(() => connections >= 2, 3000);
    assert.ok(states.some((s) => s.state === 'error' && s.error === '连接中继超时'));
  } finally {
    link.stop();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});
