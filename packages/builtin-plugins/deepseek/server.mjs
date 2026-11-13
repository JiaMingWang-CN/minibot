#!/usr/bin/env node
// DeepSeek 搜索 / 抓取的极简 stdio MCP server（扩展第 4 期 Task 5）。
// 只用 Node 内置模块与全局 fetch；实现旧版 initialize 握手 + tools 所需的最小协议。

import process from 'node:process';

const API_BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const API_KEY = process.env.DEEPSEEK_API_KEY || '';

const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        '搜索关键词，1–128 个字符。支持 site:、-site:、lang:、after:、before: 等运算符，以及用引号包起来的短语与排除词。',
    },
    count: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      default: 10,
      description: '返回结果数量，1–50，默认 10。',
    },
    ori_question: { type: 'string', description: '可选，原始问题，1–128 个字符。' },
    localization: { type: 'string', description: '可选，本地化用的 IP 地址。' },
    need_content: { type: 'boolean', default: false, description: '可选，是否同时返回网页正文，默认 false。' },
  },
  required: ['query'],
};

const FETCH_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', description: '要抓取的网址，http/https，最长 8192 个字符。' },
  },
  required: ['url'],
};

const TOOLS = [
  {
    name: 'deepseek_search',
    description:
      '用 DeepSeek 搜索网页。参数与 DeepSeek 官方搜索接口一致：query（必填）、count、ori_question、localization、need_content。支持 site:、-site:、lang:、after:、before: 等搜索运算符。',
    inputSchema: SEARCH_SCHEMA,
  },
  {
    name: 'deepseek_fetch',
    description: '抓取一个网址的正文内容。参数 url（必填，http/https）。对应 DeepSeek 官方 fetch 接口。',
    inputSchema: FETCH_SCHEMA,
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** 进行中的 tools/call：请求 id → AbortController，收到取消通知时中止并不再回复 */
const inflight = new Map();

async function callApi(path, args, signal) {
  if (API_KEY.length === 0) return { isError: true, text: '缺少 DEEPSEEK_API_KEY' };
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(args),
      signal,
    });
    const text = await response.text();
    if (!response.ok) return { isError: true, text: `DeepSeek 返回 HTTP ${response.status}：${text}` };
    return { isError: false, text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, text: `网络错误：${message}` };
  }
}

async function handle(message) {
  if (message === null || typeof message !== 'object') return;
  const id = message.id;
  const method = message.method;
  const params = message.params !== null && typeof message.params === 'object' ? message.params : {};

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'deepseek', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/cancelled') {
    inflight.get(params.requestId)?.abort();
    inflight.delete(params.requestId);
    return;
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) return;
  if (method === 'ping') {
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {};
    const path = name === 'deepseek_search' ? '/v1/tools/search' : name === 'deepseek_fetch' ? '/v1/tools/fetch' : null;
    if (path === null) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: `未知工具：${String(name)}` } });
      return;
    }
    const controller = new AbortController();
    inflight.set(id, controller);
    const out = await callApi(path, args, controller.signal);
    if (controller.signal.aborted) return;
    inflight.delete(id);
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out.text }], isError: out.isError } });
    return;
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法：${String(method)}` } });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      continue;
    }
    void handle(message).catch((err) => {
      if (message !== null && typeof message === 'object' && message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
      }
    });
  }
});
process.stdin.on('end', () => process.exit(0));
