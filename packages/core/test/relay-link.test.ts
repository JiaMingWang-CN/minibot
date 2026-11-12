import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { RelayLink, type RelayLinkState } from '../src/remote/relay-link.ts';
import { waitFor } from './kernel-harness.ts';

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
    routeId: 'a'.repeat(32),
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
