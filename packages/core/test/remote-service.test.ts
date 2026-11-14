import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { WebSocket } from 'ws';
import { RemoteService } from '../src/remote/service.ts';
import { parsePairingCode } from '../src/remote/pairing.ts';
import { deviceIdOf } from '../src/remote/store.ts';
import { startServer } from '../src/server/server.ts';
import { startRelay, type RelayHandle } from '../../relay/src/relay.ts';
import { TestPhone } from './remote-phone.ts';
import { openWs, wsCarrier } from './ws-carrier.ts';
import { fakeCrypto, kernelHarness, waitFor, type KernelHarness } from './kernel-harness.ts';

const RELAY_TOKEN = 'service-test-relay-token';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function withService(
  fn: (ctx: { h: KernelHarness; service: RemoteService }) => Promise<void>,
  o: { relayBackoffMs?: number } = {},
): Promise<void> {
  const h = await kernelHarness();
  const service = await RemoteService.start(h.kernel, {
    dataRoot: h.root,
    crypto: fakeCrypto(),
    ...(o.relayBackoffMs !== undefined ? { relayBackoffMs: o.relayBackoffMs } : {}),
  });
  try {
    await fn({ h, service });
  } finally {
    await service.close();
    await h.close();
  }
}

/** 手机经局域网连接 */
async function lanCarrier(port: number) {
  return wsCarrier(await openWs(`ws://127.0.0.1:${port}/v1`));
}

/** 手机经中继连接：等 pc_online 后再握手 */
async function relayCarrier(relayPort: number, pcPublicKey: Buffer) {
  const ws = await openWs(`ws://127.0.0.1:${relayPort}/v1`);
  let online = false;
  const carrier = wsCarrier(ws, (m) => {
    if (m['type'] === 'pc_online') online = true;
  });
  ws.send(JSON.stringify({ type: 'hello', role: 'phone', routeId: deviceIdOf(pcPublicKey), token: RELAY_TOKEN }));
  await waitFor(() => online);
  return carrier;
}

test('service 中继全链路', async () => {
  const relay = await startRelay({ host: '127.0.0.1', port: 0, token: RELAY_TOKEN });
  try {
    await withService(async ({ service }) => {
      await service.updateConfig({
        relayUrl: `ws://127.0.0.1:${relay.port}/v1`,
        relayToken: RELAY_TOKEN,
        lanEnabled: false,
      });
      assert.equal(service.status().relay, 'off');
      const status = service.startPairing();
      await waitFor(() => service.status().relay === 'connected');
      const info = parsePairingCode(status.pairing!.code);
      assert.equal(info.relay, `ws://127.0.0.1:${relay.port}/v1`);
      const pk = Buffer.from(info.pk, 'base64url');

      const first = await TestPhone.pair(await relayCarrier(relay.port, pk), status.pairing!.code);
      first.close();
      await waitFor(() => service.status().devices.every((d) => !d.online));
      const again = await TestPhone.connect(await relayCarrier(relay.port, pk), first.keys, pk);
      assert.equal(again.closed, false);
      await waitFor(() => service.status().devices[0]!.online);
      assert.equal(service.status().devices[0]!.lastVia, 'relay');
      assert.equal(service.status().devices[0]!.online, true);
    });
  } finally {
    await relay.close();
  }
});

test('service 局域网全链路', async () => {
  const port = await freePort();
  await withService(async ({ service }) => {
    await service.updateConfig({ lanPort: port });
    const status = service.startPairing();
    await waitFor(() => service.status().lan === 'listening');
    const first = await TestPhone.pair(await lanCarrier(port), status.pairing!.code);
    first.close();
    const again = await TestPhone.connect(await lanCarrier(port), first.keys, first.pcPublicKey);
    assert.equal(again.closed, false);
    assert.equal(service.status().devices[0]!.lastVia, 'lan');
  });
});

test('service 局域网非 v1', async () => {
  const port = await freePort();
  await withService(async ({ service }) => {
    await service.updateConfig({ lanPort: port });
    service.startPairing();
    await waitFor(() => service.status().lan === 'listening');
    const status = await new Promise<number>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on('error', reject);
    });
    assert.equal(status, 404);
    await assert.rejects(openWs(`ws://127.0.0.1:${port}/other`));
  });
});

test('service 无设备不监听', async () => {
  const port = await freePort();
  await withService(async ({ service }) => {
    await service.updateConfig({ lanPort: port });
    assert.equal(service.status().lan, 'off');
    await assert.rejects(openWs(`ws://127.0.0.1:${port}/v1`));
  });
});

test('service 端口占用', async () => {
  const port = await freePort();
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(port, '0.0.0.0', resolve));
  try {
    await withService(async ({ service, h }) => {
      await service.updateConfig({ lanPort: port });
      service.startPairing();
      await waitFor(() => service.status().lan === 'error');
      assert.match(service.status().lanError!, /已被占用/);
      // 内核照常
      assert.equal(h.kernel.listThreads(h.bot.id).length, 1);
    });
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test('service 中继重连', async () => {
  const port = await freePort();
  let relay: RelayHandle = await startRelay({ host: '127.0.0.1', port, token: RELAY_TOKEN });
  try {
    await withService(
      async ({ service }) => {
        await service.updateConfig({
          relayUrl: `ws://127.0.0.1:${port}/v1`,
          relayToken: RELAY_TOKEN,
          lanEnabled: false,
        });
        const status = service.startPairing();
        await waitFor(() => service.status().relay === 'connected');
        const pk = Buffer.from(parsePairingCode(status.pairing!.code).pk, 'base64url');
        const first = await TestPhone.pair(await relayCarrier(port, pk), status.pairing!.code);
        first.close();

        await relay.close();
        await waitFor(() => service.status().relay !== 'connected');
        relay = await startRelay({ host: '127.0.0.1', port, token: RELAY_TOKEN });
        await waitFor(() => service.status().relay === 'connected', 8000);
        const again = await TestPhone.connect(await relayCarrier(port, pk), first.keys, pk);
        assert.equal(again.closed, false);
      },
      { relayBackoffMs: 50 },
    );
  } finally {
    await relay.close();
  }
});

test('service 口令错', async () => {
  const relay = await startRelay({ host: '127.0.0.1', port: 0, token: RELAY_TOKEN });
  try {
    await withService(
      async ({ service }) => {
        await service.updateConfig({
          relayUrl: `ws://127.0.0.1:${relay.port}/v1`,
          relayToken: 'wrong-relay-token-000',
          lanEnabled: false,
        });
        service.startPairing();
        await waitFor(() => service.status().relay === 'error');
        assert.equal(service.status().relayError, '中继口令错误');
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(service.status().relay, 'error');
        // 改对口令后恢复
        await service.updateConfig({ relayToken: RELAY_TOKEN });
        await waitFor(() => service.status().relay === 'connected');
      },
      { relayBackoffMs: 50 },
    );
  } finally {
    await relay.close();
  }
});

test('server 管理路由与 remote_changed', async () => {
  const port = await freePort();
  await withService(async ({ h, service }) => {
    const server = await startServer(h.kernel, { staticDir: h.root, remote: service });
    try {
      await service.updateConfig({ lanPort: port, relayToken: 'secret-relay-token-abcdef' });
      const get = await fetch(`${server.origin}/api/remote`, { headers: { authorization: `Bearer ${server.token}` } });
      assert.equal(get.status, 200);
      const text = await get.text();
      assert.ok(!text.includes('secret-relay-token-abcdef'));
      assert.equal((JSON.parse(text) as { hasRelayToken: boolean }).hasRelayToken, true);

      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { origin: server.origin } });
      const seen: string[] = [];
      ws.on('message', (d) => seen.push((JSON.parse(String(d)) as { type: string }).type));
      await new Promise<void>((resolve) => ws.once('open', () => resolve()));
      ws.send(JSON.stringify({ type: 'auth', token: server.token }));
      await waitFor(() => seen.includes('ready'));

      const started = await fetch(`${server.origin}/api/remote/pairing`, {
        method: 'POST',
        headers: { authorization: `Bearer ${server.token}` },
      });
      const code = ((await started.json()) as { pairing: { code: string } }).pairing.code;
      await waitFor(() => service.status().lan === 'listening');
      seen.length = 0;
      const phone = await TestPhone.pair(await lanCarrier(port), code);
      await waitFor(() => seen.includes('remote_changed'));

      // 远程会话不能碰管理路由
      const denied = await phone.request('GET', '/api/remote');
      assert.equal(denied.status, 403);
      const denied2 = await phone.request('POST', '/api/remote/pairing');
      assert.equal(denied2.status, 403);

      const revoke = await fetch(`${server.origin}/api/remote/devices/${service.status().devices[0]!.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${server.token}` },
      });
      assert.equal(revoke.status, 200);
      await waitFor(() => phone.closed);
      ws.close();
    } finally {
      await server.close();
    }
  });
});

test('server 未传 remote 时管理路由 404', async () => {
  const h = await kernelHarness();
  const server = await startServer(h.kernel, { staticDir: h.root });
  try {
    const res = await fetch(`${server.origin}/api/remote`, { headers: { authorization: `Bearer ${server.token}` } });
    assert.equal(res.status, 404);
  } finally {
    await server.close();
    await h.close();
  }
});

test('service 中继停止后，重新开始配对会重试', async () => {
  const port = await freePort();
  let relay: RelayHandle = await startRelay({ host: '127.0.0.1', port, token: 'other-relay-token-000' });
  try {
    await withService(
      async ({ service }) => {
        await service.updateConfig({ relayUrl: `ws://127.0.0.1:${port}/v1`, relayToken: RELAY_TOKEN, lanEnabled: false });
        service.startPairing();
        await waitFor(() => service.status().relay === 'error');
        assert.equal(service.status().relayError, '中继口令错误');
        // 中继那边把口令改对了，电脑端配置没变
        await relay.close();
        relay = await startRelay({ host: '127.0.0.1', port, token: RELAY_TOKEN });
        service.startPairing();
        await waitFor(() => service.status().relay === 'connected');
      },
      { relayBackoffMs: 50 },
    );
  } finally {
    await relay.close();
  }
});

test('service 更换 relay token 后旧值不再留在脱敏集合里', () =>
  withService(async ({ h, service }) => {
    await service.updateConfig({ relayToken: 'old-relay-token-value' });
    assert.ok(h.kernel.diag.secrets.containsKnown('old-relay-token-value'));
    await service.updateConfig({ relayToken: 'new-relay-token-value' });
    assert.ok(!h.kernel.diag.secrets.containsKnown('old-relay-token-value'));
    assert.ok(h.kernel.diag.secrets.containsKnown('new-relay-token-value'));
    await service.updateConfig({ relayToken: null });
    assert.ok(!h.kernel.diag.secrets.containsKnown('new-relay-token-value'));
  }));
