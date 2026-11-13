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
import { WebToolProvider } from '../src/web/web-tools.ts';
import { SearchToolProvider } from '../src/web/search-tools.ts';
import { McpToolProvider } from '../src/mcp/tools.ts';
import type { McpManager, McpServerState, McpCallResult } from '../src/mcp/manager.ts';
import type { McpServerConfig } from '../src/mcp/config.ts';
import type { WebSettings } from '../src/extensions/store.ts';
import { dispatchApi } from '../src/server/dispatch.ts';
import { kernelHarness } from './kernel-harness.ts';

function tool(id: string, name: string): { name: string; description: string; inputSchema: Record<string, unknown> } {
  return { name, description: `${name} 描述`, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } };
}

function fakeManager(states: McpServerState[]): McpManager {
  return {
    states: () => states,
    call: async (): Promise<McpCallResult> => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  } as unknown as McpManager;
}

function searchConfig(id: string, pluginId: string): McpServerConfig {
  return {
    id,
    name: pluginId,
    shortName: pluginId,
    transport: { type: 'http', url: 'https://x/mcp', headers: {}, auth: 'none' },
    timeoutMs: 60_000,
    origin: { kind: 'plugin', pluginId },
  };
}

const BOTH_CONNECTED: McpServerState[] = [
  { id: 'plugin:deepseek:deepseek', status: 'connected', error: null, tools: [tool('d', 'deepseek_search'), tool('d', 'deepseek_fetch')] },
  { id: 'plugin:tavily:tavily', status: 'connected', error: null, tools: [tool('t', 'tavily_search')] },
];

function buildCatalog(manager: McpManager, settings: () => WebSettings): ToolCatalog {
  const catalog = new ToolCatalog();
  catalog.register(new WebToolProvider({ loadSettings: settings }));
  catalog.register(new McpToolProvider({ manager, loadServers: async () => [searchConfig('plugin:deepseek:deepseek', 'deepseek'), searchConfig('plugin:tavily:tavily', 'tavily')] }));
  catalog.register(new SearchToolProvider({ manager, loadSettings: settings, isPluginEnabled: () => true }));
  return catalog;
}

test('只出现选中那家，且没有带前缀的重复工具', async () => {
  const manager = fakeManager(BOTH_CONNECTED);
  let settings: WebSettings = { fetchEnabled: true, searchEngine: 'tavily' };
  const catalog = buildCatalog(manager, () => settings);
  const bot = newBot('b1');
  bot.extensions.web = true;
  bot.extensions.plugins = ['deepseek', 'tavily'];

  let names = (await catalog.snapshot(bot)).specs.map((s) => s.name);
  assert.ok(names.includes('tavily_search'));
  assert.equal(names.includes('deepseek_search'), false);
  assert.equal(names.includes('tavily__tavily_search'), false);

  settings = { fetchEnabled: true, searchEngine: 'deepseek' };
  names = (await catalog.snapshot(bot)).specs.map((s) => s.name);
  assert.ok(names.includes('deepseek_search'));
  assert.equal(names.includes('tavily_search'), false);
});

test('联网关闭：两家与 web_fetch 都不出现', async () => {
  const manager = fakeManager(BOTH_CONNECTED);
  const settings: WebSettings = { fetchEnabled: true, searchEngine: 'tavily' };
  const catalog = buildCatalog(manager, () => settings);
  const bot = newBot('b1');
  bot.extensions.web = false;
  const names = (await catalog.snapshot(bot)).specs.map((s) => s.name);
  assert.equal(names.includes('tavily_search'), false);
  assert.equal(names.includes('web_fetch'), false);
});

async function toolEnv(bot: ReturnType<typeof newBot>, manager: McpManager, settings: WebSettings) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-search-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.defaultWorkspace(bot.id), { recursive: true });
  await fs.mkdir(paths.memoryDir(bot.id), { recursive: true });
  const db = openDb(paths.db);
  const catalog = buildCatalog(manager, () => settings);
  const broker = new ApprovalBroker(() => {});
  const env: ToolEnv = {
    bot,
    threadId: 't1',
    workspace: paths.defaultWorkspace(bot.id),
    paths,
    home: path.join(root, 'home'),
    tracker: new ReadTracker(),
    secrets: new SecretSet(),
    revisions: new MemoryRevisions(db, paths),
    broker,
    signal: new AbortController().signal,
    toolset: await catalog.snapshot(bot),
  };
  return { env, broker, db };
}

test('走 web 审批：edits 档直接执行；ask 档请求 source=web', async () => {
  const manager = fakeManager(BOTH_CONNECTED);
  const settings: WebSettings = { fetchEnabled: true, searchEngine: 'deepseek' };

  const editsBot = newBot('b1');
  editsBot.approvalMode = 'edits';
  editsBot.extensions.web = true;
  const edits = await toolEnv(editsBot, manager, settings);
  try {
    const result = await executeTool({ type: 'tool_use', id: 'tu1', name: 'deepseek_search', input: { query: 'x' } }, edits.env);
    assert.equal(result.status, 'ok');
    assert.ok(result.content.startsWith('以下内容来自外部网页'));
    assert.ok(result.content.includes('ok'));
    assert.equal(edits.broker.pending().length, 0);
  } finally {
    edits.db.close();
  }

  const askBot = newBot('b1');
  askBot.approvalMode = 'ask';
  askBot.extensions.web = true;
  const ask = await toolEnv(askBot, manager, settings);
  try {
    const pending = executeTool({ type: 'tool_use', id: 'tu2', name: 'deepseek_search', input: { query: 'x' } }, ask.env);
    let request;
    for (let i = 0; i < 200 && request === undefined; i += 1) {
      request = ask.broker.pending()[0];
      if (request === undefined) await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(request !== undefined);
    assert.equal(request!.source, 'web');
    assert.equal(request!.alwaysKind, 'web');
    ask.broker.respond(request!.id, false);
    const result = await pending;
    assert.equal(result.status, 'denied');
  } finally {
    ask.db.close();
  }
});

test('选未连接的引擎 → 400 所选搜索引擎尚未连接', async () => {
  const h = await kernelHarness();
  try {
    const res = await dispatchApi(h.kernel, {
      method: 'PUT',
      url: new URL('http://x/api/extensions/web'),
      readBody: async () => ({ searchEngine: 'tavily' }),
    });
    assert.equal(res.status, 400);
    if ('json' in res) {
      assert.match((res.json as { error: { message: string } }).error.message, /所选搜索引擎尚未连接/);
    }
  } finally {
    await h.close();
  }
});
