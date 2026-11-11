import type {
  AddProviderInput,
  AppConfig,
  ApprovalLogEntry,
  ApprovalRequest,
  Revision,
  Bot,
  ImageInput,
  KernelEvent,
  KernelState,
  KnownModel,
  OnboardingInput,
  Preset,
  Provider,
  RemoteConfig,
  RemoteStatus,
  SearchHit,
  StoredMessage,
  TestConnectionResult,
  Thread,
  ThreadUsage,
} from '@minibot/core';

export interface Conn {
  port: number;
  token: string;
}

export interface PresetWithModels extends Preset {
  models: KnownModel[];
}

export type BotPatch = Partial<
  Pick<
    Bot,
    | 'name'
    | 'persona'
    | 'providerId'
    | 'model'
    | 'contextWindow'
    | 'maxOutputTokens'
    | 'workspace'
    | 'approvalMode'
    | 'thinkingLevel'
    | 'allowedCommands'
    | 'memoryEnabled'
  >
>;

export interface MemoryIndex {
  user: { path: string };
  topics: { name: string; summary: string | null; path: string }[];
}

export class ApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

export type Api = ReturnType<typeof createApi>;

export function createApi(conn: Conn) {
  const base = `http://127.0.0.1:${conn.port}`;

  async function request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${conn.token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(base + path, init);
    if (!response.ok) {
      let code = 'http_error';
      let message = `HTTP ${response.status}`;
      try {
        const payload = (await response.json()) as { error?: { code?: string; message?: string } };
        if (payload.error?.code !== undefined) code = payload.error.code;
        if (payload.error?.message !== undefined) message = payload.error.message;
      } catch {
        // 保留默认信息
      }
      throw new ApiError(code, message);
    }
    return response;
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const text = await (await request(method, path, body)).text();
    return (text.length === 0 ? undefined : JSON.parse(text)) as T;
  }

  const enc = encodeURIComponent;

  return {
    state: () => call<KernelState>('GET', '/api/state'),
    presets: () => call<PresetWithModels[]>('GET', '/api/presets'),
    addProvider: (input: AddProviderInput) => call<Provider>('POST', '/api/providers', input),
    updateProvider: (id: string, patch: Partial<Omit<Provider, 'id'>> & { apiKey?: string }) =>
      call<Provider>('PATCH', `/api/providers/${enc(id)}`, patch),
    testProvider: (id: string, model: string) =>
      call<TestConnectionResult>('POST', `/api/providers/${enc(id)}/test`, { model }),
    completeOnboarding: (input: OnboardingInput) => call<Bot>('POST', '/api/onboarding', input),
    deleteProvider: (id: string) => call<{ ok: true }>('DELETE', `/api/providers/${enc(id)}`),
    updateBot: (id: string, patch: BotPatch) => call<Bot>('PATCH', `/api/bots/${enc(id)}`, patch),
    settings: () => call<{ consolidationModel: AppConfig['consolidationModel'] }>('GET', '/api/settings'),
    updateSettings: (input: { consolidationModel: AppConfig['consolidationModel'] }) =>
      call<{ ok: true }>('PUT', '/api/settings', input),
    approvalLog: (before?: number, limit = 50) => {
      const search = new URLSearchParams({ limit: String(limit) });
      if (before !== undefined) search.set('before', String(before));
      return call<ApprovalLogEntry[]>('GET', `/api/approvals/log?${search.toString()}`);
    },
    listMemory: (botId: string) => call<MemoryIndex>('GET', `/api/bots/${enc(botId)}/memory`),
    readMemoryFile: (path: string) =>
      call<{ content: string; hash: string }>('GET', `/api/memory/file?path=${enc(path)}`),
    writeMemoryFile: (path: string, content: string, baseHash: string) =>
      call<{ hash: string }>('PUT', '/api/memory/file', { path, content, baseHash }),
    listRevisions: (path: string) => call<Revision[]>('GET', `/api/memory/revisions?path=${enc(path)}`),
    revert: (revisionId: number) => call<{ ok: true }>('POST', `/api/memory/revisions/${enc(String(revisionId))}/revert`),
    listThreads: (botId: string) => call<Thread[]>('GET', `/api/bots/${enc(botId)}/threads`),
    createThread: (botId: string) => call<Thread>('POST', `/api/bots/${enc(botId)}/threads`),
    renameThread: (id: string, title: string) => call<Thread>('PATCH', `/api/threads/${enc(id)}`, { title }),
    deleteThread: (id: string) => call<{ ok: true }>('DELETE', `/api/threads/${enc(id)}`),
    listMessages: (threadId: string, before?: number, limit = 100) => {
      const search = new URLSearchParams({ limit: String(limit) });
      if (before !== undefined) search.set('before', String(before));
      return call<StoredMessage[]>('GET', `/api/threads/${enc(threadId)}/messages?${search.toString()}`);
    },
    sendMessage: (threadId: string, text: string, images: ImageInput[] = []) =>
      call<{ ok: true; mode: 'turn' | 'steer' }>('POST', `/api/threads/${enc(threadId)}/messages`, {
        text,
        images,
      }),
    retry: (threadId: string) => call<{ ok: true }>('POST', `/api/threads/${enc(threadId)}/retry`),
    compact: (threadId: string) => call<{ ok: true }>('POST', `/api/threads/${enc(threadId)}/compact`),
    usage: (threadId: string) => call<ThreadUsage>('GET', `/api/threads/${enc(threadId)}/usage`),
    context: (threadId: string) =>
      call<{ tokens: number; window: number }>('GET', `/api/threads/${enc(threadId)}/context`),
    search: (q: string, botId?: string) => {
      const search = new URLSearchParams({ q });
      if (botId !== undefined) search.set('botId', botId);
      return call<SearchHit[]>('GET', `/api/search?${search.toString()}`);
    },
    remoteStatus: () => call<RemoteStatus>('GET', '/api/remote'),
    updateRemote: (patch: Partial<RemoteConfig> & { relayToken?: string | null }) =>
      call<RemoteStatus>('PUT', '/api/remote', patch),
    startPairing: () => call<RemoteStatus>('POST', '/api/remote/pairing'),
    cancelPairing: () => call<RemoteStatus>('DELETE', '/api/remote/pairing'),
    revokeDevice: (id: string) => call<RemoteStatus>('DELETE', `/api/remote/devices/${enc(id)}`),
    pendingApprovals: () => call<ApprovalRequest[]>('GET', '/api/approvals'),
    runningThreads: () => call<string[]>('GET', '/api/running'),
    /** 附件需要令牌才能读，取回后转成 blob: 地址给 <img> 用（CSP 允许 blob: 图片） */
    attachmentUrl: async (id: string): Promise<string> =>
      URL.createObjectURL(await (await request('GET', `/api/attachments/${enc(id)}`)).blob()),
  };
}

export type ClientMessage =
  | { type: 'abort'; threadId: string }
  | { type: 'approval'; id: string; approve: boolean; always?: boolean };

export interface EventConnection {
  send(message: ClientMessage): void;
  /** 每次连上（含首次和断线重连）时通知；断开期间漏掉的事件要靠它重新同步 */
  onOpen(listener: () => void): () => void;
  close(): void;
}

/** 事件推送：断线后每秒重连 */
export function connectEvents(conn: Conn, onEvent: (event: KernelEvent) => void): EventConnection {
  let socket: WebSocket | null = null;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const openListeners = new Set<() => void>();

  const open = (): void => {
    if (stopped) return;
    socket = new WebSocket(`ws://127.0.0.1:${conn.port}/ws`);
    socket.onopen = () => {
      socket?.send(JSON.stringify({ type: 'auth', token: conn.token }));
    };
    socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as { type?: unknown };
        if (parsed.type === 'ready') {
          for (const listener of openListeners) listener();
          return;
        }
        onEvent(parsed as KernelEvent);
      } catch {
        // 忽略无法解析的事件
      }
    };
    socket.onclose = () => {
      if (!stopped) retryTimer = setTimeout(open, 1000);
    };
    socket.onerror = () => {
      socket?.close();
    };
  };
  open();

  return {
    onOpen(listener) {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    send(message) {
      if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
    close() {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      socket?.close();
      socket = null;
    },
  };
}

/** File → base64（不含 data: 前缀） */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
