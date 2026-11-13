import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataPaths } from '../src/paths.ts';
import { RemoteGateway, REMOTE_PROTOCOL, type GatewayOptions } from '../src/remote/gateway.ts';
import { RemoteStore } from '../src/remote/store.ts';
import { carrierPair } from './carrier-pair.ts';
import { TestPhone } from './remote-phone.ts';
import { fakeCrypto, kernelHarness, waitFor } from './kernel-harness.ts';
import type { TimedDiagEvent } from '../src/diag/log.ts';

async function setup(o: GatewayOptions = {}) {
  const h = await kernelHarness();
  const store = await RemoteStore.open({ paths: dataPaths(h.root), crypto: fakeCrypto() });
  const gateway = new RemoteGateway(h.kernel, store, { lanAddresses: () => [], ...o });
  const events: TimedDiagEvent[] = [];
  const off = h.kernel.diag.onEvent((e) => events.push(e));
  const pair = async (): Promise<TestPhone> => {
    const { a, b } = carrierPair();
    gateway.accept(a, 'lan');
    const offer = gateway.startPairing({ lanAddresses: [] });
    return TestPhone.pair(b, offer.code, '测试手机');
  };
  const deviceId = async (): Promise<string> => {
    await waitFor(() => store.devices().length > 0);
    return store.devices()[0]!.id;
  };
  const teardown = async (): Promise<void> => {
    off();
    gateway.close();
    await h.close();
  };
  return { h, store, gateway, pair, deviceId, events, teardown };
}

function sendVersion(phone: TestPhone, version: Record<string, unknown>): void {
  phone.channel.send({ t: 'version', app: '0.1.0', protocol: 1, minPeer: 1, ...version });
}

test('ready then version', async () => {
  const s = await setup({ appVersion: '0.1.0' });
  try {
    const phone = await s.pair();
    await waitFor(() => phone.messages.some((m) => m['t'] === 'version'));
    const kinds = phone.messages.map((m) => m['t']).filter((t) => t === 'ready' || t === 'version');
    assert.deepEqual(kinds.slice(0, 2), ['ready', 'version']);
    const version = phone.messages.find((m) => m['t'] === 'version')!;
    assert.equal(version['app'], '0.1.0');
    assert.equal(version['protocol'], REMOTE_PROTOCOL);
    assert.equal(version['minPeer'], 1);
  } finally {
    await s.teardown();
  }
});

test('old phone without version works', async () => {
  const s = await setup();
  try {
    const phone = await s.pair();
    const reply = await phone.request('GET', '/api/state');
    assert.equal(reply.status, 200);
    assert.equal(s.gateway.deviceVersion(await s.deviceId()).compat, 'unknown');
  } finally {
    await s.teardown();
  }
});

test('phone outdated', async () => {
  const s = await setup({ minPhoneProtocol: 2 });
  try {
    const phone = await s.pair();
    sendVersion(phone, { protocol: 1, minPeer: 1 });
    const id = await s.deviceId();
    await waitFor(() => s.gateway.deviceVersion(id).compat === 'phone_outdated');
    const reply = await phone.request('GET', '/api/state');
    assert.equal(reply.status, 409);
    assert.equal((reply.body as { error: { code: string } }).error.code, 'incompatible');
    await waitFor(() => s.events.some((e) => e.name === 'remote.version_mismatch'));
    const event = s.events.find((e) => e.name === 'remote.version_mismatch')!;
    assert.equal(event.data['result'], 'phone_outdated');
    assert.equal(event.data['pcProtocol'], REMOTE_PROTOCOL);
    assert.equal(event.data['phoneProtocol'], 1);
    assert.equal(event.data['phoneApp'], '0.1.0');
  } finally {
    await s.teardown();
  }
});

test('pc outdated', async () => {
  const s = await setup();
  try {
    const phone = await s.pair();
    sendVersion(phone, { protocol: 1, minPeer: 2 });
    const id = await s.deviceId();
    await waitFor(() => s.gateway.deviceVersion(id).compat === 'pc_outdated');
    const reply = await phone.request('GET', '/api/state');
    assert.equal(reply.status, 409);
    assert.equal((reply.body as { error: { code: string } }).error.code, 'incompatible');
    await waitFor(() => s.events.some((e) => e.name === 'remote.version_mismatch'));
  } finally {
    await s.teardown();
  }
});

test('new connection resets compat to unknown', async () => {
  const s = await setup({ minPhoneProtocol: 2 });
  try {
    const phone = await s.pair();
    sendVersion(phone, { protocol: 1, minPeer: 1 });
    const id = await s.deviceId();
    await waitFor(() => s.gateway.deviceVersion(id).compat === 'phone_outdated');
    phone.close();
    await waitFor(() => !s.gateway.onlineDeviceIds().includes(id));
    const { a, b } = carrierPair();
    s.gateway.accept(a, 'lan');
    const next = await TestPhone.connect(b, phone.keys, phone.pcPublicKey);
    try {
      // 新会话不能沿用上一次的 phone_outdated；版本号保留供界面显示
      assert.equal(s.gateway.deviceVersion(id).compat, 'unknown');
      assert.equal(s.gateway.deviceVersion(id).appVersion, '0.1.0');
      const reply = await next.request('GET', '/api/state');
      assert.equal(reply.status, 200);
    } finally {
      next.close();
    }
  } finally {
    await s.teardown();
  }
});

test('a losing second session does not leave the device compat at unknown', async () => {
  const s = await setup();
  try {
    const phone = await s.pair();
    sendVersion(phone, {});
    const id = await s.deviceId();
    await waitFor(() => s.gateway.deviceVersion(id).compat === 'ok');
    // 同一台手机的另一条线路也完成了握手（不发 version），随后被手机关掉
    const { a, b } = carrierPair();
    s.gateway.accept(a, 'lan');
    const loser = await TestPhone.connect(b, phone.keys, phone.pcPublicKey);
    loser.close();
    await waitFor(() => s.gateway.deviceVersion(id).compat !== 'unknown');
    assert.equal(s.gateway.deviceVersion(id).compat, 'ok');
  } finally {
    await s.teardown();
  }
});
