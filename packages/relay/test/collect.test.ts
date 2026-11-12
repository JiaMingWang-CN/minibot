import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { startRelay, type RelayHandle } from '../src/relay.ts';

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

test('ws unaffected', async () => {
  const dir = tmp();
  // 数据库路径指向一个目录，打开时必然失败
  const relay = await startRelay({ host: '127.0.0.1', port: 0, token: TOKEN, collect: { dbPath: dir, maxBytes: 1024 * 1024 } });
  try {
    const status = await fetch(`http://127.0.0.1:${relay.port}/collect/v1/events`, { method: 'POST', body: eventsBody([event()]) }).then((r) => r.status);
    assert.equal(status, 500);
    const welcome = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/v1`);
      ws.on('message', (d: Buffer, bin: boolean) => {
        if (bin) return;
        resolve(String((JSON.parse(d.toString()) as { type: string }).type));
        ws.close();
      });
      ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'phone', routeId: 'a'.repeat(32), token: TOKEN })));
      ws.once('error', reject);
    });
    assert.equal(welcome, 'welcome');
  } finally {
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
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
