import type { Provider } from '../config/types.ts';
import type { ApiFormat } from '../config/types.ts';
import type { AssistantResult, Delta, StoredMessage } from './types.ts';
import { AbortedError, ModelError } from './types.ts';
import { ResultAccumulator } from './accumulator.ts';
import { parseSse } from './sse.ts';
import { chatCompletionsAdapter } from './chat-completions.ts';
import { responsesAdapter } from './responses.ts';
import { anthropicAdapter } from './anthropic.ts';
import type { Adapter, ModelRequest } from './adapter.ts';
import { SecretSet } from '../secrets/redact.ts';

export function adapterFor(f: ApiFormat): Adapter {
  if (f === 'chat_completions') return chatCompletionsAdapter;
  if (f === 'responses') return responsesAdapter;
  return anthropicAdapter;
}

export interface CallModelArgs {
  provider: Provider;
  apiKey: string;
  request: ModelRequest;
  signal: AbortSignal;
  onDelta: (d: Delta) => void;
}

export type CallModel = (a: CallModelArgs) => Promise<AssistantResult>;

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function networkCode(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (typeof cur === 'object' && cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function redactKey(text: string, apiKey: string): string {
  const set = new SecretSet();
  set.add(apiKey);
  return set.redact(text);
}

function statusKind(status: number): 'auth' | 'not_found' | 'rate_limit' | 'server' | 'bad_request' {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'bad_request';
}

function describeErrorBody(status: number, body: string): string {
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed['error'];
    if (typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>)['message'] === 'string') {
      detail = (error as Record<string, unknown>)['message'] as string;
    } else if (typeof parsed['message'] === 'string') {
      detail = parsed['message'];
    }
  } catch {
    // 非 JSON 错误体，原样使用
  }
  if (detail.length === 0) detail = '无错误详情';
  return `HTTP ${status}：${detail.slice(0, 2000)}`;
}

async function readBodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export const callModel: CallModel = async (a) => {
  const adapter = adapterFor(a.provider.format);
  const url = joinUrl(a.provider.baseUrl, adapter.path);
  const acc = new ResultAccumulator(a.onDelta);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: adapter.headers(a.apiKey),
      body: JSON.stringify(adapter.body(a.request)),
      signal: a.signal,
    });
  } catch (err) {
    if (a.signal.aborted) throw new AbortedError(acc.snapshot());
    const code = networkCode(err);
    const message = err instanceof Error ? err.message : String(err);
    throw new ModelError('network', redactKey(message, a.apiKey), { cause: code });
  }

  if (!res.ok) {
    const body = await readBodyText(res);
    const message = redactKey(describeErrorBody(res.status, body), a.apiKey);
    throw new ModelError(statusKind(res.status), message, { status: res.status });
  }

  if (res.body === null) {
    throw new ModelError('stream', '响应没有内容', { partial: acc.snapshot() });
  }

  try {
    await adapter.parse(parseSse(res.body), acc, a.request.model);
  } catch (err) {
    if (err instanceof AbortedError) throw err;
    if (a.signal.aborted) throw new AbortedError(acc.snapshot());
    if (err instanceof ModelError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ModelError('stream', redactKey(message, a.apiKey), {
      partial: acc.snapshot(),
      cause: networkCode(err),
    });
  }
  return acc.result();
};

function pingRequest(model: string): ModelRequest {
  const ping: StoredMessage = {
    id: 0,
    threadId: '',
    role: 'user',
    blocks: [{ type: 'text', text: 'ping' }],
    kind: null,
    interrupted: false,
    createdAt: 0,
  };
  return {
    model,
    system: '',
    messages: [ping],
    tools: [],
    maxTokens: 1,
    thinkingLevel: null,
  };
}

export type TestConnectionResult =
  | { ok: true }
  | { ok: false; kind: 'auth' | 'url' | 'network' | 'other'; message: string };

export async function testConnection(
  provider: Provider,
  apiKey: string,
  model: string,
  timeoutMs = 15000,
): Promise<TestConnectionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await callModel({
      provider,
      apiKey,
      request: pingRequest(model),
      signal: controller.signal,
      onDelta: () => {},
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof AbortedError) {
      return { ok: false, kind: 'network', message: '连接超时，请检查网络或地址' };
    }
    if (err instanceof ModelError) {
      if (err.cause === 'ENOTFOUND') return { ok: false, kind: 'url', message: err.message };
      if (err.kind === 'auth') return { ok: false, kind: 'auth', message: err.message };
      if (err.kind === 'not_found') return { ok: false, kind: 'url', message: err.message };
      if (err.kind === 'network') return { ok: false, kind: 'network', message: err.message };
      return { ok: false, kind: 'other', message: err.message };
    }
    return { ok: false, kind: 'other', message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
