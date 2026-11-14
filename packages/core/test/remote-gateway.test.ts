import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataPaths } from '../src/paths.ts';
import { RemoteGateway } from '../src/remote/gateway.ts';
import { RemoteStore } from '../src/remote/store.ts';
import { parsePairingCode } from '../src/remote/pairing.ts';
import { createHandshake, generateKeyPair } from '../src/remote/noise.ts';
import { FRAME_KK, FRAME_PAIR } from '../src/remote/channel.ts';
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
    lanAddresses: () => ['192.168.1.2', '10.0.0.5'],
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

test('gateway ready 带当前局域网地址与端口；局域网关闭时为空列表', () =>
  withSetup(async (s) => {
    const phone = await s.pair();
    const ready = phone.messages.find((m) => m['t'] === 'ready')!;
    assert.deepEqual(ready['lan'], ['192.168.1.2', '10.0.0.5']);
    assert.equal(ready['port'], s.store.config().lanPort);

    await s.store.updateConfig({ lanEnabled: false });
    const again = await TestPhone.connect(s.connect().phoneSide, phone.keys, phone.pcPublicKey);
    assert.deepEqual(again.messages.find((m) => m['t'] === 'ready')!['lan'], []);
  }));

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

test('gateway 配对失败不作废邀请：任意次错误 psk 之后正确配对仍成功', () =>
  withSetup(async (s) => {
    const offer = s.gateway.startPairing({ lanAddresses: [] });
    for (let i = 0; i < 8; i++) {
      await assert.rejects(TestPhone.pair(s.connect().phoneSide, offer.code, 'x', { psk: Buffer.alloc(32, i + 1) }));
    }
    assert.notEqual(s.gateway.pairing(), null);
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

test('gateway 配对完成瞬间手机断开：仍通知界面', () =>
  withSetup(async (s) => {
    const offer = s.gateway.startPairing({ lanAddresses: [] });
    let notified = 0;
    s.gateway.on(() => (notified += 1));
    const info = parsePairingCode(offer.code);
    const hs = createHandshake({ pattern: 'XXpsk3', initiator: true, s: generateKeyPair(), psk: Buffer.from(info.psk, 'base64url') });
    const { a, b } = carrierPair();
    const reply = new Promise<Buffer>((resolve) => b.onFrame(resolve));
    s.gateway.accept(a, 'lan');
    b.send(Buffer.concat([Buffer.from([FRAME_PAIR]), hs.writeMessage(Buffer.alloc(0))]));
    hs.readMessage((await reply).subarray(1));
    b.send(Buffer.concat([Buffer.from([FRAME_PAIR]), hs.writeMessage(Buffer.from('{"deviceName":"甲"}'))]));
    b.close();
    await waitFor(() => s.store.devices().length === 1);
    await waitFor(() => notified > 0);
    assert.equal(s.gateway.pairing(), null);
  }));

test('gateway KK 握手 msg1 被重放：不算在线、不更新 lastSeen，直到收到首个可解密的数据帧', () =>
  withSetup(
    async (s) => {
      const first = await s.pair();
      first.close();
      const id = s.store.devices()[0]!.id;
      await waitFor(() => !s.gateway.onlineDeviceIds().includes(id));
      const seen = s.store.devices()[0]!.lastSeenAt;

      // 抓一份手机真实发出的 KK msg1
      const hs = createHandshake({ pattern: 'KK', initiator: true, s: first.keys, rs: first.pcPublicKey });
      const msg1 = Buffer.concat([Buffer.from([FRAME_KK]), Buffer.from(id, 'hex'), hs.writeMessage(Buffer.alloc(0))]);

      const { a, b } = carrierPair();
      s.gateway.accept(a, 'lan');
      let frames = 0;
      let closed = false;
      b.onFrame(() => (frames += 1));
      b.onClose(() => (closed = true));
      b.send(msg1);
      await waitFor(() => frames >= 1);
      // 重放者解不开会话，什么都不会发生
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(s.gateway.onlineDeviceIds(), []);
      assert.equal(s.store.devices()[0]!.lastSeenAt, seen);
      const before = frames;
      s.h.kernel.sendMessage(s.h.threadId, '你好');
      await waitIdle(s.h);
      assert.equal(frames, before);
      // 没有首帧：超时后被关闭
      await waitFor(() => closed);
    },
    { handshakeTimeoutMs: 150 },
  ));

test('gateway KK 握手后手机发出首帧才算会话建立', () =>
  withSetup(async (s) => {
    const first = await s.pair();
    first.close();
    const id = s.store.devices()[0]!.id;
    const phone = await TestPhone.connect(s.connect().phoneSide, first.keys, first.pcPublicKey);
    await waitFor(() => s.gateway.onlineDeviceIds().includes(id));
    assert.equal((await phone.request('GET', '/api/state')).status, 200);
  }));

test('gateway 版本不兼容的会话：不推事件、不接受 ctl', () =>
  withSetup(async (s) => {
    const phone = await s.pair();
    phone.channel.send({ t: 'version', app: '0.0.1', protocol: 0, minPeer: 1 });
    const id = s.store.devices()[0]!.id;
    await waitFor(() => s.gateway.deviceVersion(id).compat === 'phone_outdated');
    const seen = phone.events.length;
    const approvals: string[] = [];
    s.h.kernel.respondApproval = (approvalId: string) => {
      approvals.push(approvalId);
      return true;
    };
    phone.control({ type: 'approval', id: 'a1', approve: true });
    s.h.kernel.sendMessage(s.h.threadId, '你好');
    await waitIdle(s.h);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(phone.events.length, seen);
    assert.deepEqual(approvals, []);
  }));

test('gateway 撤销后不再保留该设备的版本记录', () =>
  withSetup(async (s) => {
    const phone = await s.pair();
    phone.channel.send({ t: 'version', app: '1.2.3', protocol: 1, minPeer: 1 });
    const id = s.store.devices()[0]!.id;
    await waitFor(() => s.gateway.deviceVersion(id).appVersion === '1.2.3');
    await s.gateway.revoke(id);
    assert.deepEqual(s.gateway.deviceVersion(id), { appVersion: null, compat: 'unknown' });
  }));
