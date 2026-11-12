import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { dispatchApi, type ApiRequest } from '../src/server/dispatch.ts';
import { Kernel } from '../src/kernel.ts';
import { dataPaths } from '../src/paths.ts';
import { saveConfig } from '../src/config/config.ts';
import { RemoteGateway } from '../src/remote/gateway.ts';
import { RemoteStore } from '../src/remote/store.ts';
import { carrierPair } from './carrier-pair.ts';
import { TestPhone } from './remote-phone.ts';
import { fakeCrypto, kernelHarness } from './kernel-harness.ts';

function req(method: string, path: string, body?: unknown): ApiRequest {
  return {
    method,
    url: new URL(path, 'http://x'),
    readBody: async () => body,
  };
}

function jsonOf(res: { status: number; json?: unknown }): Record<string, unknown> {
  return res.json as Record<string, unknown>;
}

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function capturingFetch(status = 204): { fetchImpl: typeof fetch; captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchImpl = (async (url: unknown, init: { body?: unknown }) => {
    captured.push({
      url: String(url),
      body: JSON.parse(gunzipSync(Buffer.from(init.body as Uint8Array)).toString('utf8')) as Record<string, unknown>,
    });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

test('diagnostics api 读取与设置同意状态', async () => {
  const h = await kernelHarness(undefined, { collectUrl: 'https://c.test/collect', appVersion: '0.1.0' });
  try {
    const get = await dispatchApi(h.kernel, req('GET', '/api/diagnostics'));
    assert.equal(get.status, 200);
    assert.deepEqual(jsonOf(get), { consent: 'unset', available: true, appVersion: '0.1.0' });
    assert.equal((await h.kernel.state()).diagnosticsPrompt, true);

    const put = await dispatchApi(h.kernel, req('PUT', '/api/diagnostics', { consent: 'on' }));
    assert.equal(put.status, 200);
    assert.equal((await dispatchApi(h.kernel, req('GET', '/api/diagnostics'))).status, 200);
    assert.equal(jsonOf(await dispatchApi(h.kernel, req('GET', '/api/diagnostics')))['consent'], 'on');
    assert.equal((await h.kernel.state()).diagnosticsPrompt, false);

    const bad = await dispatchApi(h.kernel, req('PUT', '/api/diagnostics', { consent: 'maybe' }));
    assert.equal(bad.status, 400);
  } finally {
    await h.close();
  }
});

test('no collect url 时反馈关闭', async () => {
  const h = await kernelHarness(undefined, { collectUrl: null });
  try {
    const info = jsonOf(await dispatchApi(h.kernel, req('GET', '/api/diagnostics')));
    assert.equal(info['available'], false);
    assert.equal((await h.kernel.state()).diagnosticsPrompt, false);
    const feedback = await dispatchApi(h.kernel, req('POST', '/api/feedback', { description: 'x', attachLogs: false }));
    assert.equal(feedback.status, 404);
  } finally {
    await h.close();
  }
});

test('feedback validation', async () => {
  const { fetchImpl } = capturingFetch();
  const h = await kernelHarness(undefined, { collectUrl: 'https://c.test/collect', fetch: fetchImpl });
  try {
    const empty = await dispatchApi(h.kernel, req('POST', '/api/feedback', { description: '   ', attachLogs: false }));
    assert.equal(empty.status, 400);
    const long = await dispatchApi(
      h.kernel,
      req('POST', '/api/feedback', { description: 'x'.repeat(5001), attachLogs: false }),
    );
    assert.equal(long.status, 400);
  } finally {
    await h.close();
  }
});

test('feedback 经内核发出', async () => {
  const { fetchImpl, captured } = capturingFetch();
  const h = await kernelHarness(undefined, { collectUrl: 'https://c.test/collect', fetch: fetchImpl });
  try {
    const res = await dispatchApi(
      h.kernel,
      req('POST', '/api/feedback', { description: '有问题', contact: 'a@b.c', attachLogs: true }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(jsonOf(res), { ok: true });
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.url, 'https://c.test/collect/v1/feedback');
    assert.equal(captured[0]!.body['description'], '有问题');
    assert.equal(captured[0]!.body['contact'], 'a@b.c');
    assert.ok(typeof captured[0]!.body['logs'] === 'string');
  } finally {
    await h.close();
  }
});

test('client-error 写入日志与事件', async () => {
  const h = await kernelHarness(undefined, { collectUrl: 'https://c.test/collect' });
  try {
    const res = await dispatchApi(
      h.kernel,
      req('POST', '/api/diagnostics/client-error', {
        message: 'boom',
        stack: 'Error: boom\n    at fn (C:\\Users\\Alice\\proj\\a.ts:1:2)',
        source: 'renderer',
      }),
    );
    assert.equal(res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const logs = await h.kernel.diag.recent(0, 1024 * 1024);
    assert.ok(logs.includes('renderer.error'));
    assert.ok(logs.includes('boom'));
  } finally {
    await h.close();
  }
});

test('config migrate 生成稳定的 installId', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-diagcfg-'));
  const paths = dataPaths(root);
  await saveConfig(paths, { schemaVersion: 1, providers: [], mainBotId: null, consolidationModel: null });
  const first = await Kernel.open({ dataRoot: root, crypto: fakeCrypto() });
  await first.close();
  const raw = JSON.parse(await fs.readFile(paths.config, 'utf8')) as {
    diagnostics: { consent: string; installId: string };
  };
  assert.equal(raw.diagnostics.consent, 'unset');
  assert.match(raw.diagnostics.installId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const second = await Kernel.open({ dataRoot: root, crypto: fakeCrypto() });
  try {
    const again = JSON.parse(await fs.readFile(paths.config, 'utf8')) as {
      diagnostics: { installId: string };
    };
    assert.equal(again.diagnostics.installId, raw.diagnostics.installId);
  } finally {
    await second.close();
  }
});

test('remote denied：手机不能访问反馈接口', async () => {
  const h = await kernelHarness();
  const store = await RemoteStore.open({ paths: dataPaths(h.root), crypto: fakeCrypto() });
  const gateway = new RemoteGateway(h.kernel, store, { lanAddresses: () => [] });
  const { a, b } = carrierPair();
  try {
    gateway.accept(a, 'lan');
    const offer = gateway.startPairing({ lanAddresses: [] });
    const phone = await TestPhone.pair(b, offer.code, '测试手机');
    const res = await phone.request('POST', '/api/feedback', { description: 'x', attachLogs: false });
    assert.equal(res.status, 403);
    assert.equal((res.body as { error: { code: string } }).error.code, 'remote_forbidden');
    phone.close();
  } finally {
    gateway.close();
    await h.close();
  }
});
