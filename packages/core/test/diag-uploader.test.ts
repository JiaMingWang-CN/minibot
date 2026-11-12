import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/db.ts';
import { DiagLog } from '../src/diag/log.ts';
import { DiagnosticUploader } from '../src/diag/uploader.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import type { DiagnosticConsent } from '../src/config/types.ts';

interface Posted {
  url: string;
  body: Buffer;
  headers: Record<string, string>;
}

interface SetupOptions {
  consent?: DiagnosticConsent;
  status?: () => number;
  collectUrl?: string | null;
}

interface UploaderSetup {
  uploader: DiagnosticUploader;
  db: DatabaseSync;
  diag: DiagLog;
  posts: Posted[];
  now(): number;
  advance(ms: number): void;
  setConsent(consent: DiagnosticConsent): void;
  close(): Promise<void>;
}

const event = (n: number): { kind: 'error'; name: string; data: Record<string, number> } => ({
  kind: 'error',
  name: `err.e${n}`,
  data: { n },
});

async function setup(o: SetupOptions = {}): Promise<UploaderSetup> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-upload-'));
  const db = openDb(path.join(root, 'minibot.db'));
  const diag = new DiagLog({ dir: path.join(root, 'logs'), secrets: new SecretSet() });
  let now = 1_000_000;
  let consent: DiagnosticConsent = o.consent ?? 'unset';
  const status = o.status ?? (() => 204);
  const posts: Posted[] = [];
  const fetchImpl = (async (url: unknown, init: { body?: unknown; headers?: Record<string, string> }) => {
    posts.push({
      url: String(url),
      body: Buffer.from(init.body as Uint8Array),
      headers: init.headers ?? {},
    });
    return new Response(null, { status: status() });
  }) as unknown as typeof fetch;
  const uploader = new DiagnosticUploader({
    db,
    diag,
    collectUrl: o.collectUrl === undefined ? 'https://collect.test/collect' : o.collectUrl,
    installId: () => 'install-1',
    consent: () => consent,
    platform: 'win32',
    appVersion: '0.1.0',
    os: 'Windows 11',
    fetchImpl,
    now: () => now,
    autoStart: false,
  });
  uploader.start();
  return {
    uploader,
    db,
    diag,
    posts,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    setConsent: (next) => {
      consent = next;
      uploader.setConsent(next);
    },
    close: async () => {
      uploader.close();
      await diag.close();
      db.close();
    },
  };
}

function bodyOf(post: Posted): Record<string, unknown> {
  return JSON.parse(gunzipSync(post.body).toString('utf8')) as Record<string, unknown>;
}

test('unset no upload', async () => {
  const s = await setup({ consent: 'unset' });
  try {
    for (let i = 0; i < 60; i += 1) s.uploader.push(event(i));
    s.advance(10 * 60_000);
    await s.uploader.tick();
    assert.equal(s.posts.length, 0);
    assert.equal(s.uploader.size(), 60);
  } finally {
    await s.close();
  }
});

test('on uploads batch', async () => {
  const s = await setup({ consent: 'on' });
  try {
    for (let i = 0; i < 60; i += 1) s.uploader.push(event(i));
    await s.uploader.tick();
    assert.equal(s.posts.length, 1);
    assert.equal(s.posts[0]!.url, 'https://collect.test/collect/v1/events');
    const body = bodyOf(s.posts[0]!);
    assert.equal(body['installId'], 'install-1');
    assert.equal(body['platform'], 'win32');
    assert.equal(body['appVersion'], '0.1.0');
    assert.equal((body['events'] as unknown[]).length, 60);
    assert.equal(s.uploader.size(), 0);
  } finally {
    await s.close();
  }
});

test('off clears', async () => {
  const s = await setup({ consent: 'on' });
  try {
    for (let i = 0; i < 10; i += 1) s.uploader.push(event(i));
    assert.equal(s.uploader.size(), 10);
    s.setConsent('off');
    assert.equal(s.uploader.size(), 0);
    s.uploader.push(event(11));
    assert.equal(s.uploader.size(), 0);
  } finally {
    await s.close();
  }
});

test('cap keeps newest 1000', async () => {
  const s = await setup({ consent: 'unset' });
  try {
    for (let i = 0; i < 1005; i += 1) s.uploader.push(event(i));
    assert.equal(s.uploader.size(), 1000);
    const names = (s.db.prepare('SELECT name FROM diag_queue ORDER BY id').all() as { name: string }[]).map(
      (row) => row.name,
    );
    assert.equal(names[0], 'err.e5');
    assert.equal(names[names.length - 1], 'err.e1004');
  } finally {
    await s.close();
  }
});

test('backoff', async () => {
  const s = await setup({ consent: 'on', status: () => 503 });
  try {
    for (let i = 0; i < 60; i += 1) s.uploader.push(event(i));
    await s.uploader.tick();
    assert.equal(s.posts.length, 1);
    s.advance(30_000);
    await s.uploader.tick();
    assert.equal(s.posts.length, 1, '1 分钟内不重试');
    s.advance(30_000);
    await s.uploader.tick();
    assert.equal(s.posts.length, 2, '1 分钟后重试');

    // 连续失败后间隔封顶 1 小时
    const attempts: number[] = [s.now()];
    for (let i = 0; i < 8; i += 1) {
      s.advance(3600_000);
      await s.uploader.tick();
      attempts.push(s.now());
    }
    assert.equal(s.posts.length, 10);
    for (let i = 1; i < attempts.length; i += 1) {
      assert.ok(attempts[i]! - attempts[i - 1]! <= 3600_000);
    }
  } finally {
    await s.close();
  }
});

test('poison batch dropped', async () => {
  const s = await setup({ consent: 'on', status: () => 400 });
  try {
    for (let i = 0; i < 60; i += 1) s.uploader.push(event(i));
    await s.uploader.tick();
    assert.equal(s.posts.length, 1);
    assert.equal(s.uploader.size(), 0);
  } finally {
    await s.close();
  }
});

test('feedback attach logs', async () => {
  const s = await setup({ consent: 'unset' });
  try {
    s.diag.write('info', 'app', 'first line');
    s.diag.write('info', 'app', 'second line');
    // 强制刷盘，让 recent() 读到刚写的行
    await s.diag.recent(0, 1024 * 1024);
    await s.uploader.sendFeedback({
      description: '有问题',
      contact: 'a@b.c',
      attachLogs: true,
    });
    assert.equal(s.posts.length, 1);
    assert.equal(s.posts[0]!.url, 'https://collect.test/collect/v1/feedback');
    const withLogs = bodyOf(s.posts[0]!);
    assert.equal(withLogs['description'], '有问题');
    assert.equal(withLogs['contact'], 'a@b.c');
    const logs = withLogs['logs'] as string;
    assert.ok(logs.includes('first line'));
    assert.ok(logs.includes('second line'));
    assert.ok(Buffer.byteLength(logs) <= 1024 * 1024);

    await s.uploader.sendFeedback({ description: '没日志', attachLogs: false });
    const withoutLogs = bodyOf(s.posts[1]!);
    assert.equal(withoutLogs['logs'], undefined);
  } finally {
    await s.close();
  }
});

test('feedback network failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-upload-'));
  const db = openDb(path.join(root, 'minibot.db'));
  const diag = new DiagLog({ dir: path.join(root, 'logs'), secrets: new SecretSet() });
  const uploader = new DiagnosticUploader({
    db,
    diag,
    collectUrl: 'https://collect.test/collect',
    installId: () => 'install-1',
    consent: () => 'on',
    platform: 'win32',
    appVersion: '0.1.0',
    os: 'Windows 11',
    fetchImpl: (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch,
    autoStart: false,
  });
  try {
    await assert.rejects(
      uploader.sendFeedback({ description: 'x', attachLogs: false }),
      (err: unknown) => (err as { kind?: string }).kind === 'network',
    );
  } finally {
    uploader.close();
    await diag.close();
    db.close();
  }
});

test('no collect url queues nothing', async () => {
  const s = await setup({ consent: 'unset', collectUrl: null });
  try {
    for (let i = 0; i < 5; i += 1) s.uploader.push(event(i));
    assert.equal(s.uploader.size(), 0);
    await assert.rejects(
      s.uploader.sendFeedback({ description: 'x', attachLogs: false }),
      (err: unknown) => (err as { kind?: string }).kind === 'unavailable',
    );
  } finally {
    await s.close();
  }
});

test('queued events go through whitelist', async () => {
  const s = await setup({ consent: 'unset' });
  try {
    s.uploader.push({
      kind: 'metric',
      name: 'metric/model.latency',
      data: { model: 'bad\nname', count: 3, p50: 10 } as unknown as Record<string, string | number>,
    });
    assert.equal(s.uploader.size(), 1);
    const row = s.db.prepare('SELECT data_json FROM diag_queue').get() as { data_json: string };
    const data = JSON.parse(row.data_json) as Record<string, unknown>;
    assert.equal(data['count'], 3);
    assert.equal(data['p50'], 10);
    assert.equal(data['model'], undefined);
  } finally {
    await s.close();
  }
});

test('feedback uploads the previewed logs', async () => {
  const s = await setup({ consent: 'unset' });
  try {
    s.diag.write('info', 'app', 'before preview');
    const preview = await s.uploader.previewLogs();
    assert.ok(preview.includes('before preview'));
    s.diag.write('info', 'app', 'after preview');
    await s.diag.recent(0, 1024 * 1024);
    await s.uploader.sendFeedback({ description: 'x', attachLogs: true });
    const body = bodyOf(s.posts[0]!);
    assert.equal(body['logs'], preview);
    assert.ok(!(body['logs'] as string).includes('after preview'));
  } finally {
    await s.close();
  }
});
