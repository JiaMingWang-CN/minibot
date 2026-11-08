import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { Kernel } from '../src/kernel.ts';
import { dataPaths } from '../src/paths.ts';
import { startServer, type ServerHandle } from '../src/server/server.ts';
import type { KeyCrypto } from '../src/secrets/store.ts';
import type { CallModel } from '../src/model/client.ts';

function fakeCrypto(): KeyCrypto {
  return {
    backend: () => 'os',
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decrypt: (buf) => Buffer.from(buf.toString('utf8').slice(4), 'base64').toString('utf8'),
  };
}

function echoModel(text = '收到'): CallModel {
  return async ({ onDelta }) => {
    onDelta({ type: 'text', text });
    return {
      blocks: [{ type: 'text', text }],
      stopReason: 'end',
      usage: { inputTokens: 3, outputTokens: 1 },
    };
  };
}

interface Setup {
  root: string;
  kernel: Kernel;
  server: ServerHandle;
  botId: string;
  threadId: string;
  close(): Promise<void>;
}

async function setup(staticFiles: Record<string, string> = { 'index.html': '<!doctype html><title>ok</title>' }): Promise<Setup> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-server-'));
  const staticDir = path.join(root, 'static');
  await fs.mkdir(staticDir, { recursive: true });
  for (const [name, content] of Object.entries(staticFiles)) {
    const file = path.join(staticDir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto(), callModel: echoModel() });
  const provider = await kernel.addProvider({
    name: 'P',
    format: 'chat_completions',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'sk-server-secret-123',
  });
  const bot = await kernel.completeOnboarding({
    providerId: provider.id,
    model: 'm',
    profile: '画像内容',
  });
  const thread = kernel.createThread(bot.id);
  const server = await startServer(kernel, { staticDir });
  return {
    root,
    kernel,
    server,
    botId: bot.id,
    threadId: thread.id,
    close: async () => {
      await server.close();
      await kernel.close();
    },
  };
}

interface RequestOptions {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  auth?: boolean;
}

function request(
  server: ServerHandle,
  options: RequestOptions,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.auth !== false) headers['authorization'] = `Bearer ${server.token}`;
    let payload = options.body;
    if (payload !== undefined) headers['content-length'] = String(Buffer.byteLength(payload));
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.port,
        path: options.path,
        method: options.method ?? 'GET',
        headers,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += String(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('请求超时')));
    req.end(payload);
  });
}

test('Host 不对 → 403（静态与 API 都校验）', async () => {
  const h = await setup();
  try {
    const evilHost = `evil.com:${h.server.port}`;
    const api = await request(h.server, { path: '/api/state', headers: { host: evilHost } });
    assert.equal(api.status, 403);
    const staticRes = await request(h.server, { path: '/', headers: { host: evilHost }, auth: false });
    assert.equal(staticRes.status, 403);
  } finally {
    await h.close();
  }
});

test('缺少令牌或令牌错误 → 401', async () => {
  const h = await setup();
  try {
    const missing = await request(h.server, { path: '/api/state', auth: false });
    assert.equal(missing.status, 401);
    const wrong = await request(h.server, {
      path: '/api/state',
      headers: { authorization: 'Bearer wrong-token' },
      auth: false,
    });
    assert.equal(wrong.status, 401);
    const ok = await request(h.server, { path: '/api/state' });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.text).onboarded, true);
  } finally {
    await h.close();
  }
});

test('响应里没有任何 Access-Control-Allow-* 头；OPTIONS → 405', async () => {
  const h = await setup();
  try {
    const res = await request(h.server, { path: '/api/state' });
    const cors = Object.keys(res.headers).filter((k) => k.toLowerCase().startsWith('access-control'));
    assert.deepEqual(cors, []);
    const options = await request(h.server, { path: '/api/state', method: 'OPTIONS' });
    assert.equal(options.status, 405);
  } finally {
    await h.close();
  }
});

test('JSON 请求体超过 1MB → 413', async () => {
  const h = await setup();
  try {
    const body = JSON.stringify({
      name: 'x',
      format: 'chat_completions',
      baseUrl: 'http://x',
      pad: 'a'.repeat(1_100_000),
    });
    const res = await request(h.server, { path: '/api/providers', method: 'POST', body });
    assert.equal(res.status, 413);
    assert.equal(JSON.parse(res.text).error.code, 'payload_too_large');
  } finally {
    await h.close();
  }
});

test('静态文件：/ 与 /assets/* 不需要令牌，带 CSP', async () => {
  const h = await setup({ 'index.html': '<html>ok</html>', 'assets/style.css': 'body{}' });
  try {
    const index = await request(h.server, { path: '/', auth: false });
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'] as string, /text\/html/);
    assert.equal(
      index.headers['content-security-policy'],
      `default-src 'self'; connect-src 'self' ws://127.0.0.1:${h.server.port}`,
    );
    const css = await request(h.server, { path: '/assets/style.css', auth: false });
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'] as string, /text\/css/);
    const missing = await request(h.server, { path: '/assets/none.css', auth: false });
    assert.equal(missing.status, 404);
  } finally {
    await h.close();
  }
});

test('WS：Origin 不对 → 握手失败', async () => {
  const h = await setup();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${h.server.port}/ws`, { origin: 'http://evil.com' });
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('error', () => resolve('error'));
      ws.on('unexpected-response', () => resolve('unexpected-response'));
    });
    assert.notEqual(outcome, 'open');
    ws.terminate();
  } finally {
    await h.close();
  }
});

test('WS：5 秒内未鉴权 → close 4401；鉴权后能收到事件', async () => {
  const h = await setup();
  try {
    const unauth = new WebSocket(`ws://127.0.0.1:${h.server.port}/ws`, { origin: h.server.origin });
    const closeCode = await new Promise<number>((resolve) => {
      unauth.on('close', (code) => resolve(code));
    });
    assert.equal(closeCode, 4401);
    unauth.terminate();

    const ws = new WebSocket(`ws://127.0.0.1:${h.server.port}/ws`, { origin: h.server.origin });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(JSON.stringify({ type: 'auth', token: h.server.token }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const event = new Promise<unknown>((resolve) => {
      ws.on('message', (data) => resolve(JSON.parse(String(data))));
    });
    h.kernel.sendMessage(h.threadId, '你好');
    const received = await event;
    assert.ok(received !== undefined);
    ws.terminate();
  } finally {
    await h.close();
  }
});

test('WS：令牌不出现在 URL 里也能完成鉴权', async () => {
  const h = await setup();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${h.server.port}/ws`, { origin: h.server.origin });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    assert.equal(ws.url.includes(h.server.token), false);
    ws.send(JSON.stringify({ type: 'auth', token: h.server.token }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pong = new Promise<unknown>((resolve) => {
      ws.on('message', (data) => resolve(JSON.parse(String(data))));
    });
    h.kernel.sendMessage(h.threadId, '测试');
    await pong;
    ws.terminate();
  } finally {
    await h.close();
  }
});

test('KernelError conflict → 409', async () => {
  const h = await setup();
  try {
    const paths = dataPaths(h.root);
    const file = paths.userMd;
    const res = await request(h.server, {
      path: '/api/memory/file',
      method: 'PUT',
      body: JSON.stringify({ path: file, content: '新内容', baseHash: 'bad-hash' }),
    });
    assert.equal(res.status, 409);
    assert.equal(JSON.parse(res.text).error.code, 'conflict');
  } finally {
    await h.close();
  }
});
