import type {
  AddProviderInput,
  AppConfig,
  ApprovalRequest,
  Bot,
  KernelEvent,
  KernelState,
  KnownModel,
  OnboardingInput,
  Preset,
  Provider,
  Revision,
  StoredMessage,
  TestConnectionResult,
  Thread,
} from '@minibot/core';

export interface Conn {
  port: number;
  token: string;
}

export interface PresetWithModels extends Preset {
  models: KnownModel[];
}

export class ApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

export interface Api {
  state(): Promise<KernelState>;
  presets(): Promise<PresetWithModels[]>;
  addProvider(input: AddProviderInput): Promise<Provider>;
  updateProvider(
    id: string,
    patch: Partial<Omit<Provider, 'id'>> & { apiKey?: string },
  ): Promise<Provider>;
  deleteProvider(id: string): Promise<void>;
  testProvider(id: string, model: string): Promise<TestConnectionResult>;
  completeOnboarding(input: OnboardingInput): Promise<Bot>;
  updateBot(
    id: string,
    patch: Partial<
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
      >
    >,
  ): Promise<Bot>;
  listThreads(botId: string): Promise<Thread[]>;
  createThread(botId: string): Promise<Thread>;
  listMessages(threadId: string, before?: number, limit?: number): Promise<StoredMessage[]>;
  sendMessage(threadId: string, text: string): Promise<void>;
  compact(threadId: string): Promise<void>;
  pendingApprovals(): Promise<ApprovalRequest[]>;
  listMemory(
    botId: string,
  ): Promise<{ user: { path: string }; topics: { name: string; summary: string | null; path: string }[] }>;
  readMemoryFile(path: string): Promise<{ content: string; hash: string }>;
  writeMemoryFile(path: string, content: string, baseHash: string): Promise<{ hash: string }>;
  listRevisions(path: string): Promise<Revision[]>;
  revert(revisionId: number): Promise<void>;
  settings(): Promise<{ consolidationModel: AppConfig['consolidationModel'] }>;
  updateSettings(input: { consolidationModel: AppConfig['consolidationModel'] }): Promise<void>;
}

export function createApi(conn: Conn): Api {
  const base = `http://127.0.0.1:${conn.port}`;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${conn.token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      let code = 'http_error';
      let message = `HTTP ${response.status}`;
      try {
        const payload = (await response.json()) as { error?: { code?: string; message?: string } };
        if (payload.error?.code !== undefined) code = payload.error.code;
        if (payload.error?.message !== undefined) message = payload.error.message;
      } catch {
        // keep the default message
      }
      throw new ApiError(code, message);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text.length === 0 ? undefined : JSON.parse(text)) as T;
  }

  return {
    state: () => call('GET', '/api/state'),
    presets: () => call('GET', '/api/presets'),
    addProvider: (input) => call('POST', '/api/providers', input),
    updateProvider: (id, patch) =>
      call('PATCH', `/api/providers/${encodeURIComponent(id)}`, patch),
    deleteProvider: (id) => call('DELETE', `/api/providers/${encodeURIComponent(id)}`),
    testProvider: (id, model) =>
      call('POST', `/api/providers/${encodeURIComponent(id)}/test`, { model }),
    completeOnboarding: (input) => call('POST', '/api/onboarding', input),
    updateBot: (id, patch) => call('PATCH', `/api/bots/${encodeURIComponent(id)}`, patch),
    listThreads: (botId) => call('GET', `/api/bots/${encodeURIComponent(botId)}/threads`),
    createThread: (botId) => call('POST', `/api/bots/${encodeURIComponent(botId)}/threads`),
    listMessages: (threadId, before, limit) => {
      const search = new URLSearchParams();
      if (before !== undefined) search.set('before', String(before));
      if (limit !== undefined) search.set('limit', String(limit));
      const query = search.toString();
      return call(
        'GET',
        `/api/threads/${encodeURIComponent(threadId)}/messages${query.length > 0 ? `?${query}` : ''}`,
      );
    },
    sendMessage: (threadId, text) =>
      call('POST', `/api/threads/${encodeURIComponent(threadId)}/messages`, { text }),
    compact: (threadId) => call('POST', `/api/threads/${encodeURIComponent(threadId)}/compact`),
    pendingApprovals: () => call('GET', '/api/approvals'),
    listMemory: (botId) => call('GET', `/api/bots/${encodeURIComponent(botId)}/memory`),
    readMemoryFile: (filePath) =>
      call('GET', `/api/memory/file?path=${encodeURIComponent(filePath)}`),
    writeMemoryFile: (filePath, content, baseHash) =>
      call('PUT', '/api/memory/file', { path: filePath, content, baseHash }),
    listRevisions: (filePath) =>
      call('GET', `/api/memory/revisions?path=${encodeURIComponent(filePath)}`),
    revert: (revisionId) =>
      call('POST', `/api/memory/revisions/${encodeURIComponent(String(revisionId))}/revert`),
    settings: () => call('GET', '/api/settings'),
    updateSettings: (input) => call('PUT', '/api/settings', input),
  };
}

export type ClientMessage =
  | { type: 'abort'; threadId: string }
  | { type: 'approval'; id: string; approve: boolean };

export interface EventConnection {
  send(message: ClientMessage): void;
  close(): void;
}

export function connectEvents(
  conn: Conn,
  onEvent: (event: KernelEvent) => void,
): EventConnection {
  let socket: WebSocket | null = null;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const open = (): void => {
    if (stopped) return;
    socket = new WebSocket(`ws://127.0.0.1:${conn.port}/ws`);
    socket.onopen = () => {
      socket?.send(JSON.stringify({ type: 'auth', token: conn.token }));
    };
    socket.onmessage = (event) => {
      try {
        onEvent(JSON.parse(String(event.data)) as KernelEvent);
      } catch {
        // ignore malformed events
      }
    };
    socket.onclose = () => {
      if (stopped) return;
      retryTimer = setTimeout(open, 1000);
    };
    socket.onerror = () => {
      socket?.close();
    };
  };

  open();

  return {
    send(message) {
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    },
    close() {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      socket?.close();
      socket = null;
    },
  };
}
