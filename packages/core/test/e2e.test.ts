import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { Kernel } from '../src/kernel.ts';
import { startServer, type ServerHandle } from '../src/server/server.ts';
import { dataPaths } from '../src/paths.ts';
import type { KeyCrypto } from '../src/secrets/store.ts';
import type { CallModel } from '../src/model/client.ts';
import type { KernelEvent } from '../src/events.ts';
import type { StoredMessage } from '../src/model/types.ts';
import type { Bot } from '../src/config/types.ts';
import type { Thread } from '../src/db/threads.ts';

function fakeCrypto(): KeyCrypto {
  return {
    backend: () => 'os',
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decrypt: (buf) => Buffer.from(buf.toString('utf8').slice(4), 'base64').toString('utf8'),
  };
}

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minibot-e2e-'));
}

interface FakeVendor {
  url: string;
  calls(): number;
  close(): Promise<void>;
}

async function startFakeVendor(): Promise<FakeVendor> {
  let count = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      count += 1;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      if (count === 1) {
        send({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_read',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"hello.txt"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else if (count === 2) {
        send({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"out.txt","content":"ok"}',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({
          choices: [{ index: 0, delta: { content: '完成' }, finish_reason: null }],
        });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function httpJson(
  server: ServerHandle,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(`http://127.0.0.1:${server.port}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${server.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text.length > 0 ? JSON.parse(text) : undefined };
}

async function openWebSocket(server: ServerHandle): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin: server.origin });
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  socket.send(JSON.stringify({ type: 'auth', token: server.token }));
  return socket;
}

function waitForEvent(
  socket: WebSocket,
  predicate: (event: KernelEvent) => boolean,
  timeoutMs = 10000,
): Promise<KernelEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', handler);
      reject(new Error('等待事件超时'));
    }, timeoutMs);
    const handler = (data: WebSocket.RawData): void => {
      const event = JSON.parse(String(data)) as KernelEvent;
      if (predicate(event)) {
        clearTimeout(timer);
        socket.off('message', handler);
        resolve(event);
      }
    };
    socket.on('message', handler);
  });
}

async function waitForIdle(kernel: Kernel, threadId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('等待 turn idle 超时'));
    }, 10000);
    const off = kernel.on((event) => {
      if (event.type === 'turn' && event.threadId === threadId && event.state === 'idle') {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

function textOf(message: StoredMessage): string {
  return message.blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('');
}

test('首次启动 → 读文件（免审批）→ 写文件（ask 模式审批）→ 最终回复', async () => {
  const root = await tmpRoot();
  const staticDir = path.join(root, 'static');
  await fs.mkdir(staticDir, { recursive: true });
  await fs.writeFile(path.join(staticDir, 'index.html'), '<html></html>');

  const vendor = await startFakeVendor();
  const kernel = await Kernel.open({ dataRoot: root, crypto: fakeCrypto() });
  const server = await startServer(kernel, { staticDir });
  try {
    const providerResponse = await httpJson(server, 'POST', '/api/providers', {
      name: 'Fake',
      format: 'chat_completions',
      baseUrl: vendor.url,
      apiKey: 'sk-e2e-secret-123',
    });
    assert.equal(providerResponse.status, 200);
    const provider = providerResponse.data as { id: string };

    const onboarding = await httpJson(server, 'POST', '/api/onboarding', {
      providerId: provider.id,
      model: 'fake-model',
      name: '测试 bot',
      persona: '你是一位测试 bot。',
      profile: '测试用户。',
    });
    assert.equal(onboarding.status, 200);
    const bot = onboarding.data as Bot;
    const paths = dataPaths(root);
    const workspace = paths.defaultWorkspace(bot.id);
    await fs.writeFile(path.join(workspace, 'hello.txt'), 'hello from e2e');

    const threadResponse = await httpJson(server, 'POST', `/api/bots/${bot.id}/threads`);
    const thread = threadResponse.data as Thread;

    const socket = await openWebSocket(server);
    const approvalPromise = waitForEvent(
      socket,
      (event) => event.type === 'approval_request',
    );
    const idlePromise = waitForEvent(
      socket,
      (event) => event.type === 'turn' && event.threadId === thread.id && event.state === 'idle',
    );

    const sendResponse = await httpJson(server, 'POST', `/api/threads/${thread.id}/messages`, {
      text: '请读文件再写文件',
    });
    assert.equal(sendResponse.status, 200);

    const approval = await approvalPromise;
    assert.equal(approval.type, 'approval_request');
    if (approval.type !== 'approval_request') throw new Error('unexpected');
    assert.equal(approval.request.tool, 'write_file');
    assert.ok(approval.request.summary.includes('out.txt'));
    socket.send(JSON.stringify({ type: 'approval', id: approval.request.id, approve: true }));
    await idlePromise;

    assert.equal(await fs.readFile(path.join(workspace, 'out.txt'), 'utf8'), 'ok');
    const messagesResponse = await httpJson(
      server,
      'GET',
      `/api/threads/${thread.id}/messages?limit=50`,
    );
    const messages = messagesResponse.data as StoredMessage[];
    const last = messages[messages.length - 1]!;
    assert.equal(last.role, 'assistant');
    assert.equal(textOf(last), '完成');
    assert.ok(vendor.calls() >= 3);
    socket.terminate();
  } finally {
    await server.close();
    await kernel.close();
    await vendor.close();
  }
});

test('重启内核后历史可分页读取，记忆修订可查', async () => {
  const root = await tmpRoot();
  const helper: CallModel = async () => ({
    blocks: [{ type: 'text', text: '收到' }],
    stopReason: 'end',
    usage: { inputTokens: 4, outputTokens: 1 },
  });
  const kernel1 = await Kernel.open({
    dataRoot: root,
    crypto: fakeCrypto(),
    callModel: helper,
  });
  try {
    const provider = await kernel1.addProvider({
      name: 'Fake',
      format: 'chat_completions',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'sk-e2e-secret-123',
    });
    const bot = await kernel1.completeOnboarding({
      providerId: provider.id,
      model: 'fake-model',
      profile: '旧画像',
    });
    const thread = kernel1.createThread(bot.id);
    kernel1.sendMessage(thread.id, '第一句');
    await waitForIdle(kernel1, thread.id);
    kernel1.sendMessage(thread.id, '第二句');
    await waitForIdle(kernel1, thread.id);

    const paths = dataPaths(root);
    const opened = await kernel1.readMemoryFile(paths.userMd);
    const written = await kernel1.writeMemoryFile(
      paths.userMd,
      '新画像',
      opened.hash,
    );
    assert.equal(written.hash.length > 0, true);
    assert.equal(kernel1.listRevisions(paths.userMd).length > 0, true);
  } finally {
    await kernel1.close();
  }

  const kernel2 = await Kernel.open({
    dataRoot: root,
    crypto: fakeCrypto(),
    callModel: helper,
    home: os.homedir(),
  });
  try {
    const bots = (await kernel2.state()).bots;
    const bot = bots[0]!;
    const threads = kernel2.listThreads(bot.id);
    const thread = threads[0]!;
    const latest = kernel2.listMessages(thread.id, undefined, 2);
    assert.equal(latest.length, 2);
    assert.equal(latest[0]!.id < latest[1]!.id, true);
    const older = kernel2.listMessages(thread.id, latest[0]!.id, 2);
    assert.equal(older.length, 2);
    assert.ok(older[older.length - 1]!.id < latest[0]!.id);

    const paths = dataPaths(root);
    const revisions = kernel2.listRevisions(paths.userMd);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]!.afterContent, '新画像');
    const content = await kernel2.readMemoryFile(paths.userMd);
    assert.equal(content.content, '新画像');
  } finally {
    await kernel2.close();
  }
});
