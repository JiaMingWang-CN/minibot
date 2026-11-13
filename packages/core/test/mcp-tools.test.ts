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
import type { McpManager, McpServerState } from '../src/mcp/manager.ts';
import type { McpServerConfig } from '../src/mcp/config.ts';
import { McpToolProvider, mapMcpCallResult, toolNameFor } from '../src/mcp/tools.ts';

function config(id: string, name: string, shortName = id): McpServerConfig {
  return {
    id,
    name,
    shortName,
    transport: { type: 'http', url: 'https://example.com/mcp', headers: {}, auth: 'none' },
    timeoutMs: 60_000,
    origin: { kind: 'user' },
  };
}

function state(id: string, status: McpServerState['status'], tools: McpServerState['tools']): McpServerState {
  return { id, status, error: status === 'connected' ? null : 'x', tools };
}

function fakeManager(states: McpServerState[], callResult = { content: [{ type: 'text' as const, text: 'ok' }], isError: false }): McpManager {
  return {
    states: () => states,
    call: async () => callResult,
  } as unknown as McpManager;
}

test('命名：基本 / 非法字符 / 超长 ≤ 64 且匹配正则', () => {
  assert.equal(toolNameFor('notion', 'search', new Set()), 'notion__search');
  assert.equal(toolNameFor('notion', 'get.page', new Set()), 'notion__get_page');
  const long = toolNameFor('a'.repeat(20), 'b'.repeat(60), new Set());
  assert.ok(long.length <= 64);
  assert.match(long, /^[a-zA-Z0-9_-]{1,64}$/);
});

test('冲突：两个同名工具第二个带 6 位十六进制后缀，都能路由到各自原名', async () => {
  const taken = new Set<string>();
  const first = toolNameFor('notion', 'search', taken);
  const second = toolNameFor('notion', 'search', taken);
  assert.notEqual(first, second);
  assert.match(second, /_[0-9a-f]{6}$/);

  const manager = fakeManager([
    state('s1', 'connected', [{ name: 'search', description: 'a', inputSchema: {} }]),
    state('s2', 'connected', [{ name: 'search', description: 'b', inputSchema: {} }]),
  ]);
  const provider = new McpToolProvider({ manager, loadServers: async () => [config('s1', 'S1', 'notion'), config('s2', 'S2', 'notion')] });
  const bot = newBot('b1');
  bot.extensions.mcpServers = ['s1', 's2'];
  const tools = await provider.toolsFor(bot);
  assert.equal(tools.length, 2);
  assert.equal(new Set(tools.map((t) => t.spec.name)).size, 2);
});

test('只列已连接且被 bot 启用的 server 的工具', async () => {
  const manager = fakeManager([
    state('s1', 'connected', [{ name: 'a', description: '', inputSchema: {} }]),
    state('s2', 'failed', [{ name: 'b', description: '', inputSchema: {} }]),
    state('s3', 'connected', [{ name: 'c', description: '', inputSchema: {} }]),
  ]);
  const configs = [config('s1', 'S1'), config('s2', 'S2'), config('s3', 'S3')];
  const provider = new McpToolProvider({ manager, loadServers: async () => configs });
  const bot = newBot('b1');
  bot.extensions.mcpServers = ['s1', 's2'];
  const catalog = new ToolCatalog();
  catalog.register(provider);
  const names = (await catalog.snapshot(bot)).specs.map((s) => s.name);
  assert.ok(names.includes('s1__a'));
  assert.equal(names.includes('s2__b'), false);
  assert.equal(names.includes('s3__c'), false);
});

test('结果映射：text / image / text', () => {
  const text = mapMcpCallResult({
    content: [
      { type: 'text', text: 'a' },
      { type: 'image', mimeType: 'image/png', data: 'x' },
      { type: 'text', text: 'b' },
    ],
    isError: false,
  });
  assert.equal(text, 'a\n\n[图片：image/png，暂不支持传给模型]\n\nb');
  const other = mapMcpCallResult({ content: [{ type: 'other', typeName: 'resource', uri: 'file:///x' }], isError: false });
  assert.equal(other, '[资源：file:///x]');
});

test('审批走 mcp：edits 档调用发审批请求，serverName 为 server 名', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-mcptools-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.defaultWorkspace('b1'), { recursive: true });
  await fs.mkdir(paths.memoryDir('b1'), { recursive: true });
  const db = openDb(paths.db);
  const bot = newBot('b1');
  bot.approvalMode = 'edits';
  bot.extensions.mcpServers = ['s1'];
  const manager = fakeManager([state('s1', 'connected', [{ name: 'search', description: 'S', inputSchema: {} }])]);
  const provider = new McpToolProvider({ manager, loadServers: async () => [config('s1', 'My Server')] });
  const catalog = new ToolCatalog();
  catalog.register(provider);
  const broker = new ApprovalBroker(() => {});
  const env: ToolEnv = {
    bot,
    threadId: 't1',
    workspace: paths.defaultWorkspace('b1'),
    paths,
    home: path.join(root, 'home'),
    tracker: new ReadTracker(),
    secrets: new SecretSet(),
    revisions: new MemoryRevisions(db, paths),
    broker,
    signal: new AbortController().signal,
    toolset: await catalog.snapshot(bot),
  };
  const pending = executeTool({ type: 'tool_use', id: 'tu_1', name: 's1__search', input: {} }, env);
  let request;
  for (let i = 0; i < 200 && request === undefined; i += 1) {
    request = broker.pending()[0];
    if (request === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(request !== undefined);
  assert.equal(request.source, 'mcp');
  assert.equal(request.serverName, 'My Server');
  assert.equal(request.alwaysKind, 'mcp_tool');
  assert.equal(request.mcpToolKey, 's1/search');
  broker.respond(request.id, false);
  const result = await pending;
  assert.equal(result.status, 'denied');
  db.close();
});
