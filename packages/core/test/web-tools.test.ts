import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths } from '../src/paths.ts';
import { newBot } from '../src/config/config.ts';
import { openDb } from '../src/db/db.ts';
import { MemoryRevisions } from '../src/memory/revisions.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import { ReadTracker } from '../src/tools/read-tracker.ts';
import { ApprovalBroker } from '../src/approval/broker.ts';
import { ToolCatalog } from '../src/tools/catalog.ts';
import { executeTool, type ToolEnv } from '../src/tools/registry.ts';
import { WebToolProvider, WEB_UNTRUSTED_NOTICE } from '../src/web/web-tools.ts';
import type { SafeFetchResult } from '../src/web/safe-fetch.ts';

const LONG_BODY = Array.from(
  { length: 12 },
  (_, i) => `<p>这是第${i + 1}段正文，包含足够多的文字，用来通过至少两百个字符的正文长度检查。</p>`,
).join('');

function fakeResult(html = `<html><head><title>测试文章</title></head><body><article>${LONG_BODY}</article></body></html>`): SafeFetchResult {
  return {
    finalUrl: 'https://example.com/final',
    status: 200,
    contentType: 'text/html; charset=utf-8',
    charset: 'utf-8',
    body: Buffer.from(html, 'utf8'),
  };
}

function provider(
  fetch: (url: string, signal: AbortSignal) => Promise<SafeFetchResult> = async () => fakeResult(),
  fetchEnabled = true,
) {
  return new WebToolProvider({
    loadSettings: () => ({ fetchEnabled, searchEngine: 'none' }),
    fetch,
  });
}

async function waitForPending(broker: ApprovalBroker) {
  for (let i = 0; i < 400; i += 1) {
    const pending = broker.pending();
    if (pending.length > 0) return pending[0]!;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('没有等到审批请求');
}

async function setup(mode: 'ask' | 'edits' = 'ask') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-webtools-'));
  const paths = dataPaths(root);
  const workspace = paths.defaultWorkspace('b1');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(paths.memoryDir('b1'), { recursive: true });
  const db = openDb(paths.db);
  const bot = newBot('b1');
  bot.extensions.web = true;
  bot.approvalMode = mode;
  const broker = new ApprovalBroker(() => {});
  const catalog = new ToolCatalog();
  catalog.register(provider());
  const env: ToolEnv = {
    bot,
    threadId: 't1',
    workspace,
    paths,
    home: path.join(root, 'home'),
    tracker: new ReadTracker(),
    secrets: new SecretSet(),
    revisions: new MemoryRevisions(db, paths),
    broker,
    signal: new AbortController().signal,
    toolset: await catalog.snapshot(bot),
  };
  return { paths, bot, env, broker, catalog, close: () => db.close() };
}

function call(url = 'https://example.com/a') {
  return { type: 'tool_use' as const, id: 'tu_1', name: 'web_fetch', input: { url } };
}

test('工具出现条件：联网开关与抓取开关同时为真才有 web_fetch', async () => {
  const catalog = new ToolCatalog();
  catalog.register(provider());
  const bot = newBot('b1');
  bot.extensions.web = true;
  assert.ok((await catalog.snapshot(bot)).specs.some((s) => s.name === 'web_fetch'));
  bot.extensions.web = false;
  assert.equal((await catalog.snapshot(bot)).specs.some((s) => s.name === 'web_fetch'), false);

  const disabled = new ToolCatalog();
  disabled.register(provider(async () => fakeResult(), false));
  bot.extensions.web = true;
  assert.equal((await disabled.snapshot(bot)).specs.some((s) => s.name === 'web_fetch'), false);
});

test('成功结果：第一行是外部内容提示，含标题与地址', async () => {
  const { env, close } = await setup('edits');
  const result = await executeTool(call(), env);
  assert.equal(result.status, 'ok');
  const lines = result.content.split('\n');
  assert.equal(lines[0], WEB_UNTRUSTED_NOTICE);
  assert.ok(result.content.includes('标题：测试文章'));
  assert.ok(result.content.includes('地址：https://example.com/final'));
  assert.ok(result.content.includes('第1段正文'));
  close();
});

test('正文过短：只有空壳 div 时返回明确的失败原因', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-webtools-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.defaultWorkspace('b1'), { recursive: true });
  await fs.mkdir(paths.memoryDir('b1'), { recursive: true });
  const db = openDb(paths.db);
  const bot = newBot('b1');
  bot.extensions.web = true;
  bot.approvalMode = 'edits';
  const catalog = new ToolCatalog();
  catalog.register(provider(async () => fakeResult('<html><body><div id="app"></div></body></html>')));
  const env: ToolEnv = {
    bot,
    threadId: 't1',
    workspace: paths.defaultWorkspace('b1'),
    paths,
    home: path.join(root, 'home'),
    tracker: new ReadTracker(),
    secrets: new SecretSet(),
    revisions: new MemoryRevisions(db, paths),
    broker: new ApprovalBroker(() => {}),
    signal: new AbortController().signal,
    toolset: await catalog.snapshot(bot),
  };
  const result = await executeTool(call(), env);
  assert.equal(result.status, 'error');
  assert.equal(result.content, '正文过短，可能是需要脚本渲染的动态页面或被拦截');
  db.close();
});

test('审批：ask 档发 source web 的请求；edits 档直接执行', async () => {
  const { env, broker, close } = await setup('ask');
  const pending = executeTool(call(), env);
  const request = await waitForPending(broker);
  assert.equal(request.tool, 'web_fetch');
  assert.equal(request.source, 'web');
  assert.equal(request.alwaysKind, 'web');
  assert.equal(request.canAlwaysAllow, true);
  broker.respond(request.id, false);
  const denied = await pending;
  assert.equal(denied.status, 'denied');
  assert.equal(broker.pending().length, 0);

  env.bot.approvalMode = 'edits';
  const direct = await executeTool(call('https://example.com/b'), env);
  assert.equal(direct.status, 'ok');
  assert.equal(broker.pending().length, 0);
  close();
});
