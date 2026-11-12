import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { startRelay, type RelayHandle } from '../src/relay.ts';
import { createCollector } from '../src/collect.ts';

const TOKEN = 'relay-test-token-1234';
const QUERY = fileURLToPath(new URL('../src/query.ts', import.meta.url));
const INSTALL = 'install-0001';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'minibot-collect-'));
}

interface Harness {
  relay: RelayHandle;
  dir: string;
  db: string;
  clock: { t: number };
  post(path: string, body: Buffer | string, headers?: Record<string, string>): Promise<number>;
}

async function withCollect(
  fn: (h: Harness) => Promise<void>,
  o: { collect?: boolean } = {},
): Promise<void> {
  const dir = tmp();
  const db = join(dir, 'collect.db');
  const clock = { t: Date.parse('2026-11-12T10:00:00Z') };
  const relay = await startRelay({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    now: () => clock.t,
    ...(o.collect === false ? {} : { collect: { dbPath: db, maxBytes: 1024 * 1024 * 1024 } }),
  });
  const post = async (path: string, body: Buffer | string, headers: Record<string, string> = {}): Promise<number> => {
    const res = await fetch(`http://127.0.0.1:${relay.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : new Uint8Array(body),
    });
    await res.arrayBuffer();
    return res.status;
  };
  try {
    await fn({ relay, dir, db, clock, post });
  } finally {
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const event = (n = 0, kind = 'metric') => ({ ts: 1000 + n, kind, name: `n${n}`, data: { n } });
const eventsBody = (events: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ installId: INSTALL, platform: 'win32', appVersion: '1.2.3', os: 'Windows 11', events, ...extra });
const feedbackBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ installId: INSTALL, platform: 'android', appVersion: '1.2.3', os: 'Android 15', description: '界面卡顿', ...extra });
const gz = (s: string) => gzipSync(Buffer.from(s));
const rows = (path: string, sql: string): Record<string, unknown>[] => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
};

test('collect disabled', async () => {
  await withCollect(
    async ({ post, dir }) => {
      assert.equal(await post('/collect/v1/events', eventsBody([event()])), 404);
      assert.equal(await post('/collect/v1/feedback', feedbackBody()), 404);
      assert.deepEqual(readdirSync(dir), []);
    },
    { collect: false },
  );
});

test('events accepted', async () => {
  await withCollect(async ({ post, db, clock }) => {
    const body = eventsBody([event(1, 'start'), event(2, 'error'), event(3, 'update')]);
    assert.equal(await post('/collect/v1/events', body), 204);
    assert.equal(await post('/collect/v1/events', gz(body), { 'content-encoding': 'gzip' }), 204);
    const all = rows(db, 'SELECT * FROM events ORDER BY id');
    assert.equal(all.length, 6);
    assert.equal(rows(db, 'PRAGMA user_version')[0]!['user_version'], 1);
    const first = all[0]!;
    assert.equal(first['install_id'], INSTALL);
    assert.equal(first['platform'], 'win32');
    assert.equal(first['app_version'], '1.2.3');
    assert.equal(first['os'], 'Windows 11');
    assert.equal(first['kind'], 'start');
    assert.equal(first['name'], 'n1');
    assert.equal(first['received_at'], clock.t);
    assert.deepEqual(JSON.parse(String(first['data_json'])), { n: 1 });
    assert.deepEqual(all.slice(3).map((r) => r['kind']), ['start', 'error', 'update']);
  });
});

test('events invalid', async () => {
  await withCollect(async ({ post, db, clock }) => {
    const path = '/collect/v1/events';
    assert.equal(await post(path, eventsBody([event(1, 'x')])), 400);
    assert.equal(await post(path, JSON.stringify({ platform: 'win32', appVersion: '1', os: 'x', events: [event()] })), 400);
    assert.equal(await post(path, 'not json'), 400);
    assert.equal(await post(path, eventsBody([event()], { platform: 'linux' })), 400);
    assert.equal(await post(path, eventsBody([{ ts: 1, kind: 'start', name: 'a', data: 'str' }])), 400);
    assert.equal(await post(path, eventsBody(Array.from({ length: 201 }, (_, i) => event(i)))), 413);
    // 解压后超过 1 MB 的 gzip（压缩后很小）
    const bomb = gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x20));
    assert.ok(bomb.length < 256 * 1024);
    assert.equal(await post(path, bomb, { 'content-encoding': 'gzip' }), 413);
    assert.equal(await post(path, Buffer.from('this is not gzip'), { 'content-encoding': 'gzip' }), 400);
    // 原始 body 超过 256 KB
    assert.equal(await post(path, Buffer.alloc(300 * 1024, 0x20)), 413);
    // 所有被拒绝的请求都没有落库；再发一个合法请求确认库可用且只有它的 1 行
    clock.t += 61_000;
    assert.equal(await post(path, eventsBody([event()])), 204);
    assert.equal(rows(db, 'SELECT count(*) AS c FROM events')[0]!['c'], 1);
  });
});

test('feedback accepted', async () => {
  await withCollect(async ({ post, db, clock }) => {
    const logs = '{"ts":1,"level":"error","area":"x","msg":"boom-日志"}\n';
    assert.equal(await post('/collect/v1/feedback', gz(feedbackBody({ logs, contact: 'a@b.c' })), { 'content-encoding': 'gzip' }), 204);
    // 每次间隔超过 1 分钟，避开按 IP 的反馈限流
    for (const bad of [{ description: 'x'.repeat(5001) }, { contact: 'x'.repeat(201) }, { description: '' }]) {
      clock.t += 61_000;
      assert.equal(await post('/collect/v1/feedback', feedbackBody(bad)), 400);
    }
    const stored = rows(db, 'SELECT * FROM feedback');
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!['contact'], 'a@b.c');
    const show = spawnSync(process.execPath, [QUERY, 'feedback-show', String(stored[0]!['id']), '--db', db], { encoding: 'utf8', timeout: 10000 });
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /界面卡顿/);
    assert.match(show.stdout, /boom-日志/);
    const list = spawnSync(process.execPath, [QUERY, 'feedback', '--db', db], { encoding: 'utf8', timeout: 10000 });
    assert.match(list.stdout, /界面卡顿/);
  });
});

test('query events and install', async () => {
  await withCollect(async ({ post, db }) => {
    await post('/collect/v1/events', eventsBody([event(1, 'start'), event(1, 'start'), event(2, 'error')]));
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [QUERY, ...args], { encoding: 'utf8', timeout: 10000, env: { ...process.env, RELAY_COLLECT_DB: db } });
    const events = run('events', '--days', '36500');
    assert.equal(events.status, 0, events.stderr);
    assert.match(events.stdout, /1\.2\.3\s+n1\s+2/);
    const named = run('events', '--days', '36500', '--name', 'n2');
    assert.doesNotMatch(named.stdout, /n1/);
    assert.match(named.stdout, /n2/);
    assert.match(run('install', INSTALL).stdout, /n2/);
  });
});

test('rate limit', async () => {
  await withCollect(async ({ post, clock }) => {
    const path = '/collect/v1/events';
    for (let i = 0; i < 30; i += 1) assert.equal(await post(path, eventsBody([event(i)])), 204);
    assert.equal(await post(path, eventsBody([event(31)])), 429);
    clock.t += 61_000;
    assert.equal(await post(path, eventsBody([event(32)])), 204);

    // 每个 installId 每天 20 条反馈（每次间隔超过 1 分钟，避开按 IP 的限流）
    let ok = 0;
    for (let i = 0; i < 25; i += 1) {
      clock.t += 61_000;
      const status = await post('/collect/v1/feedback', feedbackBody());
      if (status === 204) ok += 1;
      else assert.equal(status, 429);
    }
    assert.equal(ok, 20);
    clock.t += 24 * 3600_000;
    assert.equal(await post('/collect/v1/feedback', feedbackBody()), 204);
  });
  await withCollect(async ({ post }) => {
    // 同一 IP 同一分钟第 4 次反馈
    for (let i = 0; i < 3; i += 1) assert.equal(await post('/collect/v1/feedback', feedbackBody({ installId: `install-${i}0000` })), 204);
    assert.equal(await post('/collect/v1/feedback', feedbackBody({ installId: 'install-90000' })), 429);
  });
});

test('storage full', async () => {
  const dir = tmp();
  const db = join(dir, 'collect.db');
  const start = (maxBytes: number): Promise<RelayHandle> =>
    startRelay({ host: '127.0.0.1', port: 0, token: TOKEN, collect: { dbPath: db, maxBytes } });
  try {
    const roomy = await start(1024 * 1024 * 1024);
    try {
      const res = await fetch(`http://127.0.0.1:${roomy.port}/collect/v1/events`, { method: 'POST', body: eventsBody([event()]) });
      assert.equal(res.status, 204);
    } finally {
      await roomy.close();
    }
    const tight = await start(statSync(db).size);
    try {
      const events = await fetch(`http://127.0.0.1:${tight.port}/collect/v1/events`, { method: 'POST', body: eventsBody([event(2)]) });
      assert.equal(events.status, 507);
      const feedback = await fetch(`http://127.0.0.1:${tight.port}/collect/v1/feedback`, { method: 'POST', body: feedbackBody() });
      assert.equal(feedback.status, 507);
    } finally {
      await tight.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 以下为配对用的电脑身份与客户端辅助（与 relay.test.ts 中的写法一致）
function pcKeys(): { publicKey: Buffer; privateKey: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)),
    privateKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)),
  };
}

interface Peer {
  ws: WebSocket;
  texts: Record<string, unknown>[];
  binaries: Buffer[];
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function peer(port: number, hello: Record<string, unknown>, keys?: { publicKey: Buffer; privateKey: Buffer }): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1`);
    const p: Peer = { ws, texts: [], binaries: [] };
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        p.binaries.push(Buffer.from(data));
        return;
      }
      const message = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      p.texts.push(message);
      if (message['type'] === 'challenge' && keys !== undefined) {
        const shared = diffieHellman({
          privateKey: createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), keys.privateKey]), format: 'der', type: 'pkcs8' }),
          publicKey: createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(String(message['epk']), 'base64url')]), format: 'der', type: 'spki' }),
        });
        const key = createHash('sha256').update('minibot-relay-auth/1').update(shared).digest();
        const proof = createHmac('sha256', key).update(Buffer.from(String(message['nonce']), 'base64url')).update(Buffer.from(String(hello['routeId']), 'hex')).digest('base64url');
        ws.send(JSON.stringify({ type: 'proof', proof }));
      }
    });
    ws.once('open', () => {
      ws.send(JSON.stringify(hello));
      resolve(p);
    });
    ws.once('error', reject);
  });
}

test('ws unaffected', async () => {
  const dir = tmp();
  // 数据库路径指向一个目录，打开时必然失败
  const relay = await startRelay({ host: '127.0.0.1', port: 0, token: TOKEN, collect: { dbPath: dir, maxBytes: 1024 * 1024 } });
  const peers: Peer[] = [];
  try {
    const keys = pcKeys();
    const routeId = createHash('sha256').update(keys.publicKey).digest().subarray(0, 16).toString('hex');
    const pc = await peer(relay.port, { type: 'hello', role: 'pc', routeId, token: TOKEN, pk: keys.publicKey.toString('base64url') }, keys);
    peers.push(pc);
    await waitUntil(() => pc.texts.some((t) => t['type'] === 'welcome'));
    const phone = await peer(relay.port, { type: 'hello', role: 'phone', routeId, token: TOKEN });
    peers.push(phone);
    await waitUntil(() => pc.texts.some((t) => t['type'] === 'session_open') && phone.texts.some((t) => t['type'] === 'pc_online'));
    const sessionId = String(pc.texts.find((t) => t['type'] === 'session_open')!['sessionId']);

    phone.ws.send(Buffer.from([1, 2, 3]));
    await waitUntil(() => pc.binaries.length === 1);

    // 转发进行中触发收集 500，之后两个方向仍能收发
    const status = await fetch(`http://127.0.0.1:${relay.port}/collect/v1/events`, { method: 'POST', body: eventsBody([event()]) }).then((r) => r.status);
    assert.equal(status, 500);

    phone.ws.send(Buffer.from([4, 5]));
    await waitUntil(() => pc.binaries.length === 2);
    assert.equal(pc.binaries[1]!.toString('hex'), `${sessionId}0405`);
    pc.ws.send(Buffer.concat([Buffer.from(sessionId, 'hex'), Buffer.from([9])]));
    await waitUntil(() => phone.binaries.length === 1);
    assert.deepEqual([...phone.binaries[0]!], [9]);
  } finally {
    for (const p of peers) p.ws.terminate();
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('events whitelist', async () => {
  await withCollect(async ({ post, db, clock }) => {
    const path = '/collect/v1/events';
    const ev = (over: Record<string, unknown>) => ({ ts: 1, kind: 'error', name: 'app.crash', data: { code: 'E1' }, ...over });
    const bad: unknown[] = [
      ev({ ts: '1' }),
      ev({ name: 5 }),
      ev({ name: 'x'.repeat(65) }),
      ev({ name: 'Has Upper' }),
      ev({ name: 'has space' }),
      ev({ data: { nested: { a: 1 } } }),
      ev({ data: { list: [1] } }),
      ev({ data: { text: 'x'.repeat(65) } }),
      ev({ data: { text: 'a\u001bb' } }),
      ev({ data: { 'bad key': 1 } }),
    ];
    for (const e of bad) {
      clock.t += 61_000;
      assert.equal(await post(path, eventsBody([ev({}), e])), 400, JSON.stringify(e));
    }
    // 短字段：带控制字符、过长
    for (const extra of [{ installId: 'a'.repeat(65) }, { installId: 'a\nb' }, { appVersion: 'v'.repeat(33) }, { os: 'o'.repeat(65) }, { os: 'x\u0000' }]) {
      clock.t += 61_000;
      assert.equal(await post(path, eventsBody([ev({})], extra)), 400, JSON.stringify(extra));
    }
    // 合规：data 值为 string/number/boolean/null
    clock.t += 61_000;
    assert.equal(await post(path, eventsBody([ev({ name: 'a/b_c-d.e1', data: { s: 'ok', n: 1.5, b: false, z: null, presetId: 'p1' } })])), 204);
    // 被拒绝的整批都没有落库
    assert.equal(rows(db, 'SELECT count(*) AS c FROM events')[0]!['c'], 1);
  });
});

test('events stack exception', async () => {
  await withCollect(async ({ post, db, clock }) => {
    const path = '/collect/v1/events';
    const withStack = (stack: unknown) => eventsBody([{ ts: 1, kind: 'error', name: 'error.x', data: { code: 'E', stack } }]);
    const line = 'at fn (app.asar/dist/main.cjs:10:5)\n';
    const ok = line.repeat(200).slice(0, 4096);
    assert.equal(ok.length, 4096);
    assert.equal(await post(path, withStack(ok)), 204);
    clock.t += 61_000;
    assert.equal(await post(path, withStack(ok + 'x')), 400);
    assert.equal(await post(path, withStack(`at a${String.fromCharCode(27)}[31m`)), 400);
    assert.equal(await post(path, withStack(`a${String.fromCharCode(13)}b`)), 400);
    assert.equal(await post(path, withStack(5)), 400);
    // 其他键的长字符串仍然受 64 字限制
    assert.equal(await post(path, eventsBody([{ ts: 1, kind: 'error', name: 'error.x', data: { other: 'x'.repeat(65) } }])), 400);
    assert.equal(rows(db, 'SELECT count(*) AS c FROM events')[0]!['c'], 1);
  });
});

test('wrong field types and encodings', async () => {
  await withCollect(async ({ post, clock }) => {
    const cases: [string, Buffer | string, Record<string, string>?][] = [
      ['/collect/v1/feedback', feedbackBody({ contact: 5 })],
      ['/collect/v1/feedback', feedbackBody({ logs: { a: 1 } })],
      ['/collect/v1/feedback', feedbackBody({ logs: 5 })],
      ['/collect/v1/feedback', feedbackBody({ description: 7 })],
      ['/collect/v1/feedback', feedbackBody({ contact: 'a\u0007b' })],
      ['/collect/v1/events', eventsBody([event()]), { 'content-encoding': 'br' }],
      ['/collect/v1/feedback', feedbackBody(), { 'content-encoding': 'br' }],
    ];
    for (const [path, body, headers] of cases) {
      clock.t += 61_000;
      assert.equal(await post(path, body, headers), 400, `${path} ${String(body).slice(0, 80)}`);
    }
    // 描述允许换行
    clock.t += 61_000;
    assert.equal(await post('/collect/v1/feedback', feedbackBody({ description: '第一行\n第二行' })), 204);
  });
});

test('drains oversized request after 429', async () => {
  await withCollect(async ({ post, relay, clock }) => {
    const path = '/collect/v1/events';
    for (let i = 0; i < 30; i += 1) assert.equal(await post(path, eventsBody([event(i)])), 204);
    // 限流 429 时带着较大的请求体：先回响应，之后服务仍正常
    assert.equal(await post(path, JSON.stringify({ pad: 'x'.repeat(200 * 1024) })), 429);
    const other = await fetch(`http://127.0.0.1:${relay.port}/collect/v1/feedback`, { method: 'POST', body: feedbackBody() });
    assert.equal(other.status, 204);
    clock.t += 61_000;
    assert.equal(await post(path, eventsBody([event(99)])), 204);
  });
});

test('global write cap', async () => {
  await withCollect(async ({ post, clock }) => {
    // 每条反馈解压后约 7.5 MB，压缩后很小；三条合计超过 20 MB/分钟
    const big = (n: number) => gz(feedbackBody({ installId: `install-big${n}`, logs: 'a'.repeat(7.5 * 1024 * 1024) }));
    assert.equal(await post('/collect/v1/feedback', big(1), { 'content-encoding': 'gzip' }), 204);
    assert.equal(await post('/collect/v1/feedback', big(2), { 'content-encoding': 'gzip' }), 204);
    assert.equal(await post('/collect/v1/feedback', big(3), { 'content-encoding': 'gzip' }), 429);
    // 窗口过去后恢复
    clock.t += 61_000;
    assert.equal(await post('/collect/v1/feedback', big(4), { 'content-encoding': 'gzip' }), 204);
  });
});

test('collector closed returns 503 and does not reopen', async () => {
  const dir = tmp();
  const db = join(dir, 'collect.db');
  const collector = createCollector({ dbPath: db, maxBytes: 1024 * 1024, now: Date.now, log: () => {} });
  collector.close();
  const server = createServer((req, res) => {
    void collector.handle(req, res, '127.0.0.1');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/collect/v1/events`, { method: 'POST', body: eventsBody([event()]) });
    assert.equal(res.status, 503);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('query strips control characters and filters by kind', async () => {
  await withCollect(async ({ post, db }) => {
    const esc = String.fromCharCode(0x1b);
    // 服务端会拒绝控制符，这里模拟旧数据或被绕过的情况，直接写库
    await post('/collect/v1/feedback', feedbackBody());
    const w = new DatabaseSync(db);
    w.prepare('UPDATE feedback SET description = ?, logs = ?, contact = ? WHERE id = 1').run(`带转义${esc}[31m红
第二行`, `日志${esc}]0;title${String.fromCharCode(7)}尾`, `c${esc}x`);
    w.close();
    await post('/collect/v1/events', eventsBody([event(1, 'crash'), event(2, 'start')]));
    const run = (...args: string[]) => spawnSync(process.execPath, [QUERY, ...args, '--db', db], { encoding: 'utf8', timeout: 10000 });
    const show = run('feedback-show', '1');
    assert.equal(show.status, 0, show.stderr);
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(show.stdout));
    assert.match(show.stdout, /带转义\[31m红\n第二行/);
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(run('feedback').stdout));
    const crash = run('events', '--days', '36500', '--kind', 'crash');
    assert.match(crash.stdout, /n1/);
    assert.doesNotMatch(crash.stdout, /n2/);
  });
});

test('collect disabled keeps plain ws behavior', async () => {
  const relay = await startRelay({ host: '127.0.0.1', port: 0, token: TOKEN });
  try {
    assert.equal(await fetch(`http://127.0.0.1:${relay.port}/v1`).then((r) => r.status), 426);
    assert.equal(await fetch(`http://127.0.0.1:${relay.port}/`).then((r) => r.status), 426);
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/other`);
      ws.once('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
      ws.once('open', () => resolve('open'));
      ws.once('error', () => {});
    });
    assert.equal(outcome, '400');
  } finally {
    await relay.close();
  }
});

test('unknown upgrade path', async () => {
  await withCollect(async ({ relay }) => {
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/other`);
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('rejected'));
    });
    assert.equal(outcome, 'rejected');
    assert.equal(await fetch(`http://127.0.0.1:${relay.port}/anything`).then((r) => r.status), 404);
    assert.equal(await fetch(`http://127.0.0.1:${relay.port}/collect/v1/unknown`, { method: 'POST' }).then((r) => r.status), 404);
  });
});
