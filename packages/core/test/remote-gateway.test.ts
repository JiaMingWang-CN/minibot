import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataPaths } from '../src/paths.ts';
import { RemoteGateway } from '../src/remote/gateway.ts';
import { RemoteStore } from '../src/remote/store.ts';
import { parsePairingCode } from '../src/remote/pairing.ts';
import { generateKeyPair } from '../src/remote/noise.ts';
import { carrierPair, type MemoryCarrier } from './carrier-pair.ts';
import { TestPhone } from './remote-phone.ts';
import { fakeCrypto, kernelHarness, textModel, waitFor, waitIdle, type KernelHarness } from './kernel-harness.ts';
import type { CallModel } from '../src/model/client.ts';

const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex');

async function setup(o: { now?: () => number; handshakeTimeoutMs?: number; model?: CallModel } = {}) {
  const h = await kernelHarness(o.model ?? textModel());
  const store = await RemoteStore.open({ paths: dataPaths(h.root), crypto: fakeCrypto() });
  const gateway = new RemoteGateway(h.kernel, store, {
    ...(o.now !== undefined ? { now: o.now } : {}),
    ...(o.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: o.handshakeTimeoutMs } : {}),
  });
  const connect = (via: 'lan' | 'relay' = 'lan'): { phoneSide: MemoryCarrier; closed: () => boolean } => {
    const { a, b } = carrierPair();
    gateway.accept(a, via);
    let closed = false;
    b.onClose(() => (closed = true));
    return { phoneSide: b, closed: () => closed };
  };
  const pair = async (name = '测试手机') => {
    const offer = gateway.startPairing({ lanAddresses: ['192.168.1.2'] });
    return TestPhone.pair(connect().phoneSide, offer.code, name);
  };
  const teardown = async () => {
    gateway.close();
    await h.close();
  };
  return { h, store, gateway, connect, pair, teardown };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function withSetup(fn: (s: Setup) => Promise<void>, o: Parameters<typeof setup>[0] = {}): Promise<void> {
  const s = await setup(o);
  try {
    await fn(s);
  } finally {
    await s.teardown();
  }
}

test('gateway 配对', () =>
  withSetup(async (s) => {
    const offer = s.gateway.startPairing({ lanAddresses: ['192.168.1.2'] });
    const info = parsePairingCode(offer.code);
    assert.deepEqual(info.lan, ['192.168.1.2']);
    const phone = await TestPhone.pair(s.connect().phoneSide, offer.code, '我的手机');
    assert.ok(phone.messages.some((m) => m['t'] === 'paired'));
    assert.equal(phone.pcName, s.store.config().pcName);
    assert.equal(s.store.devices().length, 1);
    assert.equal(s.store.devices()[0]!.name, '我的手机');
    assert.equal(s.gateway.pairing(), null);
    const again = TestPhone.pair(s.connect().phoneSide, offer.code);
    await assert.rejects(again);
  }));

test('gateway 邀请过期', () => {
  let t = 1_000_000;
  return withSetup(
    async (s) => {
      const offer = s.gateway.startPairing({ lanAddresses: [] });
      t += 300_001;
      assert.equal(s.gateway.pairing(), null);
      await assert.rejects(TestPhone.pair(s.connect().phoneSide, offer.code));
      assert.equal(s.store.devices().length, 0);
    },
    { now: () => t },
  );
});

test('gateway 5 次失败', () =>
  withSetup(async (s) => {
    const offer = s.gateway.startPairing({ lanAddresses: [] });
    for (let i = 0; i < 5; i++) {
      await assert.rejects(TestPhone.pair(s.connect().phoneSide, offer.code, 'x', { psk: Buffer.alloc(32, i + 1) }));
    }
    assert.equal(s.gateway.pairing(), null);
    await assert.rejects(TestPhone.pair(s.connect().phoneSide, offer.code));
    assert.equal(s.store.devices().length, 0);
  }));

test('gateway 错误尝试不影响之前正确配对的前 4 次内', () =>
  withSetup(async (s) => {
    const offer = s.gateway.startPairing({ lanAddresses: [] });
    for (let i = 0; i < 4; i++) {
      await assert.rejects(TestPhone.pair(s.connect().phoneSide, offer.code, 'x', { psk: Buffer.alloc(32, i + 1) }));
    }
    await TestPhone.pair(s.connect().phoneSide, offer.code);
    assert.equal(s.store.devices().length, 1);
  }));

test('gateway 日常连接', () =>
  withSetup(async (s) => {
    const first = await s.pair();
    const keys = first.keys;
    first.close();
    const phone = await TestPhone.connect(s.connect('relay').phoneSide, keys, first.pcPublicKey);
    const res = await phone.request('GET', '/api/state');
    assert.equal(res.status, 200);
    assert.equal(s.store.devices()[0]!.lastVia, 'relay');
  }));

test('gateway 白名单', () =>
  withSetup(async (s) => {
    const phone = await s.pair();
    const res = await phone.request('PUT', '/api/settings', { consolidationModel: null });
    assert.equal(res.status, 403);
    assert.equal((res.body as { error: { code: string } }).error.code, 'remote_forbidden');
  }));

test('gateway 发图片', () =>
  withSetup(async (s) => {
    const phone = await s.pair();
    const image = Buffer.concat([PNG_HEADER, Buffer.alloc(5 * 1024 * 1024 - PNG_HEADER.length - 1, 7)]).toString('base64');
    const images = [0, 1, 2, 3].map(() => ({ mediaType: 'image/png', data: image }));
    const res = await phone.request('POST', `/api/threads/${s.h.threadId}/messages`, { text: '四张图', images });
    assert.equal(res.status, 200);
    await waitIdle(s.h);
    const list = await phone.request('GET', `/api/threads/${s.h.threadId}/messages`);
    const blocks = (list.body as { blocks: { type: string }[] }[])[0]!.blocks;
    assert.equal(blocks.filter((b) => b.type === 'image').length, 4);
  }));

test('gateway 事件', () =>
  withSetup(async (s) => {
    const phone = await s.pair();
    const res = await phone.request('POST', `/api/threads/${s.h.threadId}/messages`, { text: '你好' });
    assert.equal(res.status, 200);
    await waitFor(() => phone.events.some((e) => e.type === 'turn' && e.state === 'idle'));
    const types = phone.events.map((e) => (e.type === 'turn' ? `turn ${e.state}` : e.type));
    const running = types.indexOf('turn running');
    const delta = types.indexOf('delta');
    const reply = types.lastIndexOf('message');
    const idle = types.indexOf('turn idle');
    assert.ok(running >= 0 && running < delta && delta < reply && reply < idle, types.join());
    assert.ok(!types.includes('memory_changed'));
  }));

test('gateway 审批', async () => {
  let calls = 0;
  const model: CallModel = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        blocks: [{ type: 'tool_use', id: 'tu1', name: 'write_file', input: { path: 'out.txt', content: 'ok' } }],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    return { blocks: [{ type: 'text', text: '完成' }], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } };
  };
  await withSetup(
    async (s) => {
      const phone = await s.pair();
      await phone.request('POST', `/api/threads/${s.h.threadId}/messages`, { text: '写文件' });
      await waitFor(() => phone.events.some((e) => e.type === 'approval_request'));
      const request = phone.events.find((e) => e.type === 'approval_request');
      assert.ok(request && request.type === 'approval_request');
      phone.control({ type: 'approval', id: request.request.id, approve: true });
      await waitFor(() => s.h.events.some((e) => e.type === 'approval_resolved' && e.result === 'approved'));
      await waitIdle(s.h);
    },
    { model },
  );
});

test('gateway 撤销', () =>
  withSetup(async (s) => {
    const phone = await s.pair();
    const deviceId = s.store.devices()[0]!.id;
    assert.deepEqual(s.gateway.onlineDeviceIds(), [deviceId]);
    assert.equal(await s.gateway.revoke(deviceId), true);
    await waitFor(() => phone.closed);
    assert.deepEqual(s.gateway.onlineDeviceIds(), []);
    await assert.rejects(TestPhone.connect(s.connect().phoneSide, phone.keys, phone.pcPublicKey));
  }));

test('gateway 未知设备', () =>
  withSetup(async (s) => {
    await s.pair();
    await assert.rejects(TestPhone.connect(s.connect().phoneSide, generateKeyPair(), s.store.identity().publicKey));
  }));

test('gateway 握手超时', () =>
  withSetup(
    async (s) => {
      const c = s.connect();
      await waitFor(() => c.closed());
    },
    { handshakeTimeoutMs: 80 },
  ));

test('gateway 垃圾首帧', () =>
  withSetup(async (s) => {
    for (const frame of [Buffer.from([9, 9, 9]), Buffer.alloc(0), Buffer.from([2, 1, 2])]) {
      const c = s.connect();
      c.phoneSide.send(frame);
      await waitFor(() => c.closed());
    }
  }));

test('gateway 密钥库不可用', async () => {
  const h: KernelHarness = await kernelHarness();
  try {
    const store = await RemoteStore.open({
      paths: dataPaths(h.root),
      crypto: { ...fakeCrypto(), backend: () => 'basic_text' },
      platform: 'linux',
    });
    const gateway = new RemoteGateway(h.kernel, store);
    assert.throws(() => gateway.startPairing({ lanAddresses: [] }), /没有可用的密钥库/);
    const { a, b } = carrierPair();
    let closed = false;
    b.onClose(() => (closed = true));
    gateway.accept(a, 'lan');
    await waitFor(() => closed);
  } finally {
    await h.close();
  }
});
