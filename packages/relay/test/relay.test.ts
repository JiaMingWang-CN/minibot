import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startRelay, type RelayHandle } from '../src/relay.ts';

const TOKEN = 'relay-test-token-1234';

// 测试用电脑身份：路由 ID 是公钥 SHA-256 的前 16 字节
interface PcKeys {
  publicKey: Buffer;
  privateKey: Buffer;
}
function pcKeys(): PcKeys {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)),
    privateKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)),
  };
}
const routeOf = (keys: PcKeys): string => createHash('sha256').update(keys.publicKey).digest().subarray(0, 16).toString('hex');
function proofFor(keys: PcKeys, epk: Buffer, nonce: Buffer, routeId: string): string {
  const shared = diffieHellman({
    privateKey: createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), keys.privateKey]), format: 'der', type: 'pkcs8' }),
    publicKey: createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), epk]), format: 'der', type: 'spki' }),
  });
  const key = createHash('sha256').update('minibot-relay-auth/1').update(shared).digest();
  return createHmac('sha256', key).update(nonce).update(Buffer.from(routeId, 'hex')).digest('base64url');
}

const PC = pcKeys();
const ROUTE = routeOf(PC);

interface Client {
  ws: WebSocket;
  texts: Record<string, unknown>[];
  binaries: Buffer[];
  closed: Promise<number>;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function connect(
  relay: RelayHandle,
  hello: unknown | null,
  opts: { raw?: Buffer; prove?: PcKeys | null } = {},
): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/v1`);
  const texts: Record<string, unknown>[] = [];
  const binaries: Buffer[] = [];
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  const h = hello as { role?: string; routeId?: string } | null;
  // 电脑角色默认用测试身份答挑战；prove: null 表示不会答（冒充者）
  const prover = opts.prove === undefined ? (h?.role === 'pc' ? PC : null) : opts.prove;
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      binaries.push(Buffer.from(data));
      return;
    }
    const message = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
    texts.push(message);
    if (message['type'] === 'challenge' && prover !== null) {
      const proof = proofFor(prover, Buffer.from(String(message['epk']), 'base64url'), Buffer.from(String(message['nonce']), 'base64url'), h!.routeId!);
      ws.send(JSON.stringify({ type: 'proof', proof }));
    }
  });
  ws.on('error', () => {});
  await new Promise<void>((resolve) => ws.once('open', () => resolve()));
  if (opts.raw !== undefined) ws.send(opts.raw, { binary: true });
  else if (hello !== null) ws.send(JSON.stringify(hello));
  return { ws, texts, binaries, closed };
}

const hello = (role: 'pc' | 'phone', token = TOKEN, routeId = ROUTE, pk = PC.publicKey) =>
  role === 'pc'
    ? { type: 'hello', role, routeId, token, pk: pk.toString('base64url') }
    : { type: 'hello', role, routeId, token };
const types = (c: Client): unknown[] => c.texts.map((t) => t['type']).filter((t) => t !== 'challenge');

async function withRelay(fn: (relay: RelayHandle) => Promise<void>, helloTimeoutMs = 5000): Promise<void> {
  const relay = await startRelay({ host: '127.0.0.1', port: 0, token: TOKEN, helloTimeoutMs });
  try {
    await fn(relay);
  } finally {
    await relay.close();
  }
}

test('relay 转发', async () => {
  await withRelay(async (relay) => {
    const pc = await connect(relay, hello('pc'));
    await waitFor(() => types(pc).includes('welcome'));
    const phone = await connect(relay, hello('phone'));
    await waitFor(() => types(pc).includes('session_open') && types(phone).includes('pc_online'));
    const sessionId = String(pc.texts.find((t) => t['type'] === 'session_open')!['sessionId']);
    assert.match(sessionId, /^[0-9a-f]{32}$/);

    phone.ws.send(Buffer.from([1, 2, 3]));
    await waitFor(() => pc.binaries.length === 1);
    assert.equal(pc.binaries[0]!.toString('hex'), `${sessionId}010203`);

    pc.ws.send(Buffer.concat([Buffer.from(sessionId, 'hex'), Buffer.from([4])]));
    await waitFor(() => phone.binaries.length === 1);
    assert.deepEqual([...phone.binaries[0]!], [4]);
  });
});

test('relay 多手机', async () => {
  await withRelay(async (relay) => {
    const pc = await connect(relay, hello('pc'));
    const p1 = await connect(relay, hello('phone'));
    const p2 = await connect(relay, hello('phone'));
    await waitFor(() => pc.texts.filter((t) => t['type'] === 'session_open').length === 2);
    const ids = pc.texts.filter((t) => t['type'] === 'session_open').map((t) => String(t['sessionId']));
    assert.notEqual(ids[0], ids[1]);

    p1.ws.send(Buffer.from([9]));
    p2.ws.send(Buffer.from([8]));
    await waitFor(() => pc.binaries.length === 2);
    const bySession = new Map(pc.binaries.map((b) => [b.subarray(0, 16).toString('hex'), b[16]]));
    assert.equal(new Set(bySession.values()).size, 2);

    pc.ws.send(Buffer.concat([Buffer.from(ids[1]!, 'hex'), Buffer.from([7])]));
    await waitFor(() => p2.binaries.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(p1.binaries.length, 0);
  });
});

test('relay 电脑离线', async () => {
  await withRelay(async (relay) => {
    const phone = await connect(relay, hello('phone'));
    await waitFor(() => types(phone).includes('pc_offline'));
    const pc = await connect(relay, hello('pc'));
    await waitFor(() => types(phone).includes('pc_online') && types(pc).includes('session_open'));
  });
});

test('relay 顶替', async () => {
  await withRelay(async (relay) => {
    const pc1 = await connect(relay, hello('pc'));
    const phone = await connect(relay, hello('phone'));
    await waitFor(() => types(phone).includes('pc_online'));
    const pc2 = await connect(relay, hello('pc'));
    assert.equal(await pc1.closed, 4409);
    await waitFor(() => types(pc2).filter((t) => t === 'session_open').length === 1);
    assert.deepEqual(types(phone), ['welcome', 'pc_online', 'pc_offline', 'pc_online']);
  });
});

test('relay 口令错', async () => {
  await withRelay(async (relay) => {
    assert.equal(await (await connect(relay, hello('phone', 'wrong-token-0000000'))).closed, 4401);
  });
});

test('relay 无 hello', async () => {
  await withRelay(async (relay) => {
    assert.equal(await (await connect(relay, null)).closed, 4400);
  }, 150);
});

test('relay hello 格式错', async () => {
  await withRelay(async (relay) => {
    assert.equal(await (await connect(relay, { type: 'hello', role: 'x', routeId: 'bad', token: TOKEN })).closed, 4400);
  });
});

test('relay 超大帧', async () => {
  await withRelay(async (relay) => {
    const phone = await connect(relay, hello('phone'));
    await waitFor(() => types(phone).includes('welcome'));
    phone.ws.send(Buffer.alloc(67585));
    assert.equal(await phone.closed, 4413);
  });
});

test('relay 第 9 部手机', async () => {
  await withRelay(async (relay) => {
    const phones: Client[] = [];
    for (let i = 0; i < 8; i++) phones.push(await connect(relay, hello('phone')));
    await waitFor(() => phones.every((p) => types(p).includes('welcome')));
    assert.equal(await (await connect(relay, hello('phone'))).closed, 4429);
  });
});

test('relay 电脑踢会话', async () => {
  await withRelay(async (relay) => {
    const pc = await connect(relay, hello('pc'));
    const phone = await connect(relay, hello('phone'));
    await waitFor(() => types(pc).includes('session_open'));
    const sessionId = pc.texts.find((t) => t['type'] === 'session_open')!['sessionId'];
    pc.ws.send(JSON.stringify({ type: 'session_close', sessionId }));
    await phone.closed;
  });
});

test('relay 手机断开通知电脑', async () => {
  await withRelay(async (relay) => {
    const pc = await connect(relay, hello('pc'));
    const phone = await connect(relay, hello('phone'));
    await waitFor(() => types(pc).includes('session_open'));
    phone.ws.close();
    await waitFor(() => types(pc).includes('session_close'));
  });
});

test('relay 限流', async () => {
  let t = 1_000_000;
  const relay = await startRelay({ host: '127.0.0.1', port: 0, token: TOKEN, now: () => t });
  try {
    const clients: Client[] = [];
    for (let i = 0; i < 30; i++) clients.push(await connect(relay, null));
    assert.equal(await (await connect(relay, null)).closed, 4429);
    t += 61_000;
    const ok = await connect(relay, hello('phone'));
    await waitFor(() => types(ok).includes('welcome'));
  } finally {
    await relay.close();
  }
});

test('relay 启动校验', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/main.ts', import.meta.url))], {
    env: { ...process.env, RELAY_TOKEN: 'short', RELAY_PORT: '0' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RELAY_TOKEN/);
});

test('relay 反代后按真实 IP 限流', async () => {
  const relay = await startRelay({ host: '127.0.0.1', port: 0, token: TOKEN, trustProxy: true });
  try {
    const open = (ip: string) =>
      new Promise<number | null>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/v1`, { headers: { 'x-forwarded-for': `9.9.9.9, ${ip}` } });
        ws.on('error', () => {});
        ws.on('close', (code) => resolve(code));
        ws.on('open', () => setTimeout(() => resolve(null), 50));
      });
    for (let i = 0; i < 30; i++) assert.equal(await open('10.0.0.1'), null);
    assert.equal(await open('10.0.0.1'), 4429);
    // 另一个真实 IP 不受影响；最左边可伪造的值不参与计数
    assert.equal(await open('10.0.0.2'), null);
  } finally {
    await relay.close();
  }
});

test('relay 冒充电脑：有口令、知道公钥，但答不出挑战', async () => {
  await withRelay(async (relay) => {
    const pc = await connect(relay, hello('pc'));
    const phone = await connect(relay, hello('phone'));
    await waitFor(() => types(phone).includes('pc_online'));
    // 公钥写在配对二维码里，谁都拿得到；没有私钥就答不出挑战
    const fake = await connect(relay, hello('pc'), { prove: pcKeys() });
    assert.equal(await fake.closed, 4403);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(pc.ws.readyState, WebSocket.OPEN);
    assert.deepEqual(types(phone), ['welcome', 'pc_online']);
  });
});

test('relay 冒充电脑：公钥与路由 ID 对不上', async () => {
  await withRelay(async (relay) => {
    const other = pcKeys();
    const fake = await connect(relay, hello('pc', TOKEN, ROUTE, other.publicKey), { prove: other });
    assert.equal(await fake.closed, 4403);
  });
});

test('relay 冒充电脑：迟迟不答挑战', async () => {
  await withRelay(async (relay) => {
    const fake = await connect(relay, hello('pc'), { prove: null });
    assert.equal(await fake.closed, 4400);
  }, 150);
});

test('relay 心跳清掉窗口内没有命中的 IP', async () => {
  let t = 1_000_000;
  const relay = await startRelay({ host: '127.0.0.1', port: 0, token: TOKEN, now: () => t, pingIntervalMs: 20 });
  try {
    const c = await connect(relay, hello('phone'));
    await waitFor(() => types(c).includes('welcome'));
    assert.equal(relay.trackedIps(), 1);
    c.ws.close();
    await c.closed;
    t += 61_000;
    await waitFor(() => relay.trackedIps() === 0);
  } finally {
    await relay.close();
  }
});

test('relay 对端积压超过上限就关掉那条连接', async () => {
  const relay = await startRelay({ host: '127.0.0.1', port: 0, token: TOKEN, maxBufferedBytes: 256 * 1024 });
  try {
    const pc = await connect(relay, hello('pc'));
    await waitFor(() => types(pc).includes('welcome'));
    const phone = await connect(relay, hello('phone'));
    await waitFor(() => types(pc).includes('session_open'));
    const sessionId = Buffer.from(String(pc.texts.find((t) => t['type'] === 'session_open')!['sessionId']), 'hex');
    // 手机不读：暂停它的 socket，电脑一直往手机发
    (phone.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    const frame = Buffer.concat([sessionId, Buffer.alloc(60_000, 1)]);
    for (let i = 0; i < 1500; i++) {
      pc.ws.send(frame);
      if (i % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // 积压超限后中继已关闭那条连接；恢复读取，客户端才看得到关闭帧
    (phone.ws as unknown as { _socket: { resume(): void } })._socket.resume();
    assert.equal(await phone.closed, 4408);
  } finally {
    await relay.close();
  }
});
