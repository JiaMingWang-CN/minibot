import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';
import { Kernel, KernelError } from '../kernel.ts';
import type { AddProviderInput, OnboardingInput } from '../kernel.ts';
import { knownModels } from '../config/presets.ts';

const MAX_BODY_BYTES = 1024 * 1024;

class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function errorStatus(code: KernelError['code']): number {
  if (code === 'not_found') return 404;
  if (code === 'conflict' || code === 'provider_in_use') return 409;
  if (code === 'invalid' || code === 'key_not_persistable') return 400;
  return 500;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  let tooLarge = false;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
    } else {
      chunks.push(buffer);
    }
  }
  if (tooLarge) throw new HttpError(413, 'payload_too_large', '请求体超过 1MB');
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) throw new KernelError('invalid', '请求体为空');
  try {
    return JSON.parse(text);
  } catch {
    throw new KernelError('invalid', '请求体不是合法 JSON');
  }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KernelError('invalid', '请求体必须是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw new KernelError('invalid', `${key} 必须是字符串`);
  return value;
}

function optionalNumber(raw: string | null): number | undefined {
  if (raw === null || raw.length === 0) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new KernelError('invalid', '数字参数无效');
  return value;
}

export async function handleApi(
  kernel: Kernel,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  try {
    await route(kernel, req, res, url);
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof KernelError) {
      sendJson(res, errorStatus(err.code), { error: { code: err.code, message: err.message } });
      return;
    }
    sendJson(res, 500, { error: { code: 'internal', message: '服务器内部错误' } });
  }
}

async function route(
  kernel: Kernel,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const method = req.method ?? 'GET';
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, await kernel.state());
    return;
  }
  if (method === 'GET' && pathname === '/api/presets') {
    sendJson(
      res,
      200,
      kernel.presets().map((preset) => ({ ...preset, models: knownModels(preset.id) })),
    );
    return;
  }
  if (method === 'GET' && pathname === '/api/approvals') {
    sendJson(res, 200, kernel.pendingApprovals());
    return;
  }
  if (method === 'GET' && pathname === '/api/settings') {
    sendJson(res, 200, kernel.settings());
    return;
  }
  if (method === 'PUT' && pathname === '/api/settings') {
    const body = objectBody(await readJsonBody(req));
    const value = body['consolidationModel'];
    if (value !== null && (typeof value !== 'object' || value === undefined)) {
      throw new KernelError('invalid', 'consolidationModel 无效');
    }
    await kernel.updateSettings({
      consolidationModel: value as { providerId: string; model: string } | null,
    });
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === 'POST' && pathname === '/api/providers') {
    const body = objectBody(await readJsonBody(req));
    const provider = await kernel.addProvider(body as unknown as AddProviderInput);
    sendJson(res, 200, provider);
    return;
  }
  if (method === 'POST' && pathname === '/api/onboarding') {
    const body = objectBody(await readJsonBody(req));
    const bot = await kernel.completeOnboarding(body as unknown as OnboardingInput);
    sendJson(res, 200, bot);
    return;
  }
  if (method === 'PUT' && pathname === '/api/memory/file') {
    const body = objectBody(await readJsonBody(req));
    const filePath = stringField(body, 'path');
    const content = stringField(body, 'content');
    const baseHash = stringField(body, 'baseHash');
    sendJson(res, 200, await kernel.writeMemoryFile(filePath, content, baseHash));
    return;
  }

  let match = /^\/api\/providers\/([^/]+)$/.exec(pathname);
  if (match !== null) {
    const id = decodeURIComponent(match[1]!);
    if (method === 'PATCH') {
      const body = objectBody(await readJsonBody(req));
      sendJson(res, 200, await kernel.updateProvider(id, body));
      return;
    }
    if (method === 'DELETE') {
      await kernel.deleteProvider(id);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  match = /^\/api\/providers\/([^/]+)\/test$/.exec(pathname);
  if (match !== null && method === 'POST') {
    const id = decodeURIComponent(match[1]!);
    const body = objectBody(await readJsonBody(req));
    const model = stringField(body, 'model');
    sendJson(res, 200, await kernel.testProvider(id, model));
    return;
  }

  match = /^\/api\/bots\/([^/]+)$/.exec(pathname);
  if (match !== null && method === 'PATCH') {
    const id = decodeURIComponent(match[1]!);
    const body = objectBody(await readJsonBody(req));
    sendJson(res, 200, await kernel.updateBot(id, body));
    return;
  }

  match = /^\/api\/bots\/([^/]+)\/threads$/.exec(pathname);
  if (match !== null) {
    const id = decodeURIComponent(match[1]!);
    if (method === 'GET') {
      sendJson(res, 200, kernel.listThreads(id));
      return;
    }
    if (method === 'POST') {
      sendJson(res, 200, kernel.createThread(id));
      return;
    }
  }

  match = /^\/api\/bots\/([^/]+)\/memory$/.exec(pathname);
  if (match !== null && method === 'GET') {
    const id = decodeURIComponent(match[1]!);
    sendJson(res, 200, await kernel.listMemory(id));
    return;
  }

  match = /^\/api\/threads\/([^/]+)\/messages$/.exec(pathname);
  if (match !== null) {
    const id = decodeURIComponent(match[1]!);
    if (method === 'GET') {
      const before = optionalNumber(url.searchParams.get('before'));
      const limit = optionalNumber(url.searchParams.get('limit'));
      sendJson(res, 200, kernel.listMessages(id, before, limit));
      return;
    }
    if (method === 'POST') {
      const body = objectBody(await readJsonBody(req));
      const text = stringField(body, 'text');
      kernel.sendMessage(id, text);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  match = /^\/api\/threads\/([^/]+)\/compact$/.exec(pathname);
  if (match !== null && method === 'POST') {
    const id = decodeURIComponent(match[1]!);
    kernel.compact(id);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && pathname === '/api/memory/file') {
    const filePath = url.searchParams.get('path');
    if (filePath === null) throw new KernelError('invalid', '缺少 path 参数');
    sendJson(res, 200, await kernel.readMemoryFile(filePath));
    return;
  }
  if (method === 'GET' && pathname === '/api/memory/revisions') {
    const filePath = url.searchParams.get('path');
    if (filePath === null) throw new KernelError('invalid', '缺少 path 参数');
    sendJson(res, 200, kernel.listRevisions(filePath));
    return;
  }

  match = /^\/api\/memory\/revisions\/([^/]+)\/revert$/.exec(pathname);
  if (match !== null && method === 'POST') {
    const revisionId = Number(decodeURIComponent(match[1]!));
    if (!Number.isInteger(revisionId)) throw new KernelError('invalid', '修订 id 无效');
    await kernel.revert(revisionId);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: { code: 'not_found', message: '接口不存在' } });
}
