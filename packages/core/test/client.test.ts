import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { callModel, testConnection } from '../src/model/client.ts';
import { AbortedError, ModelError } from '../src/model/types.ts';
import { REDACTED } from '../src/secrets/redact.ts';
import type { Provider } from '../src/config/types.ts';
import type { ModelRequest } from '../src/model/adapter.ts';
import type { StoredMessage } from '../src/model/types.ts';

interface TestServer {
  url: string;
  port: number;
  requests: { url: string; headers: http.IncomingHttpHeaders }[];
  close(): Promise<void>;
}

async function startServer(handler: http.RequestListener): Promise<TestServer> {
  const server = http.createServer();
  const requests: TestServer['requests'] = [];
  const sockets = new Set<Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('request', (req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function provider(url: string): Provider {
  return { id: 'p', name: 'p', format: 'chat_completions', baseUrl: url };
}

function request(): ModelRequest {
  const msg: StoredMessage = {
    id: 1,
    threadId: 't',
    role: 'user',
    blocks: [{ type: 'text', text: 'hi' }],
    kind: null,
    interrupted: false,
    createdAt: 0,
  };
  return { model: 'm', system: 'S', messages: [msg], tools: [], maxTokens: 128000, thinkingLevel: null };
}

function sse(res: http.ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
}

test('URL = baseUrl 去掉末尾 / 再拼 path', async () => {
  const key = 'sk-test-secret-123';
  const server = await startServer((_req, res) => {
    sse(res);
    res.end('data: [DONE]\n\n');
  });
  try {
    await callModel({
      provider: provider(`${server.url}/v1/`),
      apiKey: key,
      request: request(),
      signal: new AbortController().signal,
      onDelta: () => {},
    });
    assert.equal(server.requests[0]?.url, '/v1/chat/completions');
    assert.equal(server.requests[0]?.headers['authorization'], `Bearer ${key}`);
  } finally {
    await server.close();
  }
});

test('401 → ModelError kind auth；错误信息经过脱敏', async () => {
  const key = 'sk-test-secret-123';
  const server = await startServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `invalid key ${key}` } }));
  });
  try {
    await assert.rejects(
      callModel({
        provider: provider(server.url),
        apiKey: key,
        request: request(),
        signal: new AbortController().signal,
        onDelta: () => {},
      }),
      (err: unknown) => {
        assert.ok(err instanceof ModelError);
        assert.equal(err.kind, 'auth');
        assert.equal(err.status, 401);
        assert.equal(err.message.includes(key), false);
        assert.ok(err.message.includes(REDACTED));
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('429 → rate_limit；500 → server；404 → not_found', async () => {
  for (const [status, kind] of [
    [429, 'rate_limit'],
    [500, 'server'],
    [404, 'not_found'],
  ] as const) {
    const server = await startServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `status ${status}` } }));
    });
    try {
      await assert.rejects(
        callModel({
          provider: provider(server.url),
          apiKey: 'sk-test-secret-123',
          request: request(),
          signal: new AbortController().signal,
          onDelta: () => {},
        }),
        (err: unknown) => {
          assert.ok(err instanceof ModelError);
          assert.equal(err.kind, kind);
          assert.equal(err.status, status);
          return true;
        },
      );
    } finally {
      await server.close();
    }
  }
});

test('流中途断开 → ModelError kind stream，partial 含已收到文本（Review Focus 4 的前半）', async () => {
  const server = await startServer((_req, res) => {
    sse(res);
    res.write('data: {"choices":[{"index":0,"delta":{"content":"部分"},"finish_reason":null}]}\n\n', () => {
      setTimeout(() => res.destroy(), 5);
    });
  });
  try {
    await assert.rejects(
      callModel({
        provider: provider(server.url),
        apiKey: 'sk-test-secret-123',
        request: request(),
        signal: new AbortController().signal,
        onDelta: () => {},
      }),
      (err: unknown) => {
        assert.ok(err instanceof ModelError);
        assert.equal(err.kind, 'stream');
        assert.deepEqual(err.partial, [{ type: 'text', text: '部分' }]);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('abort → AbortedError，partial 含已收到文本', async () => {
  const server = await startServer((_req, res) => {
    sse(res);
    res.write('data: {"choices":[{"index":0,"delta":{"content":"部分"},"finish_reason":null}]}\n\n');
    setTimeout(() => res.end(), 1000);
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(
      callModel({
        provider: provider(server.url),
        apiKey: 'sk-test-secret-123',
        request: request(),
        signal: controller.signal,
        onDelta: () => {},
      }),
      (err: unknown) => {
        assert.ok(err instanceof AbortedError);
        assert.deepEqual(err.partial, [{ type: 'text', text: '部分' }]);
        return true;
      },
    );
  } finally {
    clearTimeout(timer);
    await server.close();
  }
});

test('testConnection：401→auth，404→url，连接被拒→network，200→ok', async () => {
  const okServer = await startServer((_req, res) => {
    sse(res);
    res.end('data: [DONE]\n\n');
  });
  try {
    assert.deepEqual(
      await testConnection(provider(okServer.url), 'sk-test-secret-123', 'm'),
      { ok: true },
    );
  } finally {
    await okServer.close();
  }

  const authServer = await startServer((_req, res) => {
    res.writeHead(401);
    res.end();
  });
  try {
    const result = await testConnection(provider(authServer.url), 'sk-test-secret-123', 'm');
    assert.equal(result.ok, false);
    assert.equal((result as { kind: string }).kind, 'auth');
  } finally {
    await authServer.close();
  }

  const notFoundServer = await startServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  try {
    const result = await testConnection(provider(notFoundServer.url), 'sk-test-secret-123', 'm');
    assert.equal(result.ok, false);
    assert.equal((result as { kind: string }).kind, 'url');
  } finally {
    await notFoundServer.close();
  }

  const deadServer = await startServer((_req, res) => res.end());
  const port = deadServer.port;
  await deadServer.close();
  const refused = await testConnection(provider(`http://127.0.0.1:${port}`), 'sk-test-secret-123', 'm');
  assert.equal(refused.ok, false);
  assert.equal((refused as { kind: string }).kind, 'network');
});
