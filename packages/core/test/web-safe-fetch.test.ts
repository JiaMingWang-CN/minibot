import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { FetchError, safeFetch } from '../src/web/safe-fetch.ts';

async function withServer(
  handler: http.RequestListener,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const allowLocal = (ip: string): boolean => !ip.startsWith('127.');

function expectCode(code: string) {
  return (err: unknown): boolean => err instanceof FetchError && err.code === code;
}

test('拒绝本机端口：blocked，且服务器一个请求都没收到', async () => {
  let hits = 0;
  await withServer(
    (_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('should not happen');
    },
    async (base) => {
      await assert.rejects(
        safeFetch(`${base}/api/state`, new AbortController().signal),
        expectCode('blocked'),
      );
      assert.equal(hits, 0);
    },
  );
});

test('拒绝 localhost', async () => {
  await assert.rejects(
    safeFetch('http://localhost/', new AbortController().signal, { lookup: async () => ['127.0.0.1'] }),
    expectCode('blocked'),
  );
});

test('拒绝解析到内网的域名：只要有一个地址被拒就整体拒绝', async () => {
  await assert.rejects(
    safeFetch('http://a.test/', new AbortController().signal, {
      lookup: async () => ['8.8.8.8', '10.0.0.1'],
    }),
    expectCode('blocked'),
  );
});

test('跳转到内网被拒', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(302, { Location: 'http://10.0.0.1/' });
      res.end();
    },
    async (base) => {
      await assert.rejects(
        safeFetch(`${base}/start`, new AbortController().signal, { isBlocked: allowLocal }),
        expectCode('blocked'),
      );
    },
  );
});

test('跳转上限：连续 6 次 302 报 too_many_redirects，5 次成功', async () => {
  const redirectServer = (redirects: number): http.RequestListener => {
    let count = 0;
    return (_req, res) => {
      count += 1;
      if (count <= redirects) {
        res.writeHead(302, { Location: '/next' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    };
  };

  await withServer(redirectServer(6), async (base) => {
    await assert.rejects(
      safeFetch(`${base}/start`, new AbortController().signal, { isBlocked: allowLocal }),
      expectCode('too_many_redirects'),
    );
  });

  await withServer(redirectServer(5), async (base) => {
    const result = await safeFetch(`${base}/start`, new AbortController().signal, { isBlocked: allowLocal });
    assert.equal(result.status, 200);
    assert.equal(result.body.toString('utf8'), 'ok');
  });
});

test('凭据与协议：带用户名密码或非 http(s) 都报 invalid_url', async () => {
  await assert.rejects(
    safeFetch('http://u:p@example.com/', new AbortController().signal),
    expectCode('invalid_url'),
  );
  await assert.rejects(
    safeFetch('file:///etc/passwd', new AbortController().signal),
    expectCode('invalid_url'),
  );
});

test('体积上限：没有 Content-Length 持续输出 6 MB → too_large', async () => {
  const chunk = Buffer.alloc(1024 * 1024, 0x78);
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      for (let i = 0; i < 6; i += 1) res.write(chunk);
      res.end();
    },
    async (base) => {
      await assert.rejects(
        safeFetch(`${base}/big`, new AbortController().signal, { isBlocked: allowLocal }),
        expectCode('too_large'),
      );
    },
  );
});

test('超时：服务器慢慢吐数据时按注入的超时中断', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('x');
      const timer = setInterval(() => res.write('x'), 30);
      res.on('close', () => clearInterval(timer));
    },
    async (base) => {
      const started = Date.now();
      await assert.rejects(
        safeFetch(`${base}/slow`, new AbortController().signal, { isBlocked: allowLocal, timeoutMs: 150 }),
        expectCode('timeout'),
      );
      assert.ok(Date.now() - started < 3000);
    },
  );
});

test('中断：外部 signal 中止 → aborted', async () => {
  await withServer(
    (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('late');
      }, 1000);
    },
    async (base) => {
      const controller = new AbortController();
      const promise = safeFetch(`${base}/hold`, controller.signal, { isBlocked: allowLocal });
      setTimeout(() => controller.abort(), 50);
      await assert.rejects(promise, expectCode('aborted'));
    },
  );
});

test('内容类型：image/png → unsupported_type', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([1, 2, 3]));
    },
    async (base) => {
      await assert.rejects(
        safeFetch(`${base}/img`, new AbortController().signal, { isBlocked: allowLocal }),
        expectCode('unsupported_type'),
      );
    },
  );
});

test('正常抓取：返回内容类型、字符集与正文', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=gbk' });
      res.end('<html><body>hi</body></html>');
    },
    async (base) => {
      const result = await safeFetch(`${base}/page`, new AbortController().signal, { isBlocked: allowLocal });
      assert.equal(result.status, 200);
      assert.equal(result.contentType, 'text/html; charset=gbk');
      assert.equal(result.charset, 'gbk');
      assert.ok(result.body.toString('utf8').includes('hi'));
      assert.ok(result.finalUrl.startsWith(base));
    },
  );
});

/** 防止被测代码挂住时测试也挂住：超过 ms 仍未结束就判失败 */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`超过 ${ms}ms 仍未返回`)), ms).unref()),
  ]);
}

function stalledGzip(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const gz = gzipSync(Buffer.from(`<html><body>${'a'.repeat(5000)}</body></html>`));
  res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
  res.write(gz.subarray(0, 10));
}

test('压缩响应停住时按超时中断，不挂住', async () => {
  await withServer(stalledGzip, async (base) => {
    await assert.rejects(
      within(safeFetch(`${base}/gz`, new AbortController().signal, { isBlocked: allowLocal, timeoutMs: 150 }), 3000),
      expectCode('timeout'),
    );
  });
});

test('压缩响应停住时外部中止 → aborted，不挂住', async () => {
  await withServer(stalledGzip, async (base) => {
    const controller = new AbortController();
    const promise = safeFetch(`${base}/gz`, controller.signal, { isBlocked: allowLocal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(within(promise, 3000), expectCode('aborted'));
  });
});

test('不支持的内容类型：报错后立即关闭连接', async () => {
  let closed = false;
  await withServer(
    (req, res) => {
      req.socket.on('close', () => {
        closed = true;
      });
      res.writeHead(200, { 'content-type': 'image/png' });
      res.write(Buffer.alloc(1024));
    },
    async (base) => {
      await assert.rejects(
        safeFetch(`${base}/img`, new AbortController().signal, { isBlocked: allowLocal }),
        expectCode('unsupported_type'),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(closed, true);
    },
  );
});

test('格式错误的网址 → invalid_url', async () => {
  await assert.rejects(safeFetch('not a url', new AbortController().signal), expectCode('invalid_url'));
});

test('DNS 解析停住：超时与外部中止都能结束', async () => {
  const never = async (): Promise<string[]> => new Promise<string[]>(() => {});
  await assert.rejects(
    within(safeFetch('http://slow.test/', new AbortController().signal, { lookup: never, timeoutMs: 150 }), 3000),
    expectCode('timeout'),
  );
  const controller = new AbortController();
  const promise = safeFetch('http://slow.test/', controller.signal, { lookup: never });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(within(promise, 3000), expectCode('aborted'));
});
