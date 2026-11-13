import { existsSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport, auth as sdkAuth } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { OAuthClientProvider, Transport } from '@modelcontextprotocol/client';
import type { KernelEvent } from '../events.ts';
import { AbortedError } from '../model/types.ts';
import type { SecretStore } from '../secrets/store.ts';
import { killTree } from '../tools/process.ts';
import type { McpServerConfig } from './config.ts';
import { buildStdioEnv } from './stdio-env.ts';
import { McpOAuthProvider, startOAuthCallback } from './oauth.ts';

export type McpStatus = 'connecting' | 'connected' | 'failed' | 'needs_login' | 'stopped';

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'other'; typeName: string; uri?: string };

export interface McpCallResult {
  content: McpContent[];
  isError: boolean;
}

export interface McpServerState {
  id: string;
  status: McpStatus;
  error: string | null;
  tools: McpToolInfo[];
}

export interface McpManagerOptions {
  loadServers: () => Promise<McpServerConfig[]>;
  /** 至少一个 bot 启用的 server id */
  enabledServerIds: () => Promise<Set<string>>;
  secretStore: SecretStore;
  emit: (e: KernelEvent) => void;
  home: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** 测试注入：连接超时，默认 30 秒 */
  connectTimeoutMs?: number;
  /** 测试注入：崩溃后重启延迟 */
  restartDelayMs?: number;
  /** 连续失败上限，默认 3 */
  maxRestarts?: number;
  /** 错误文本脱敏；内核传入 secrets.redact */
  redact?: (text: string) => string;
  /** OAuth 客户端信息与 token 存储；没有则不传 authProvider */
  authProvider?: (server: McpServerConfig, redirectUrl: string) => McpOAuthProvider;
  /** 测试注入：走 SDK 的 auth() 或模拟流程 */
  oauthAuth?: (provider: OAuthClientProvider, options: { serverUrl: string; authorizationCode?: string; iss?: string }) => Promise<'AUTHORIZED' | 'REDIRECT'>;
  /** 授权回调等待上限，默认 5 分钟 */
  loginTimeoutMs?: number;
  /** 测试注入的传输层（例如模拟永远不响应的 server） */
  transportFactory?: (server: McpServerConfig) => Transport;
}

interface Entry {
  config: McpServerConfig;
  status: McpStatus;
  error: string | null;
  tools: McpToolInfo[];
  client: Client | null;
  transport: Transport | null;
  restartCount: number;
  generation: number;
  intentional: boolean;
}

const CLIENT_INFO = { name: 'minibot', version: '0.1.0' };

function toolInfo(tool: { name: string; description?: string; inputSchema?: unknown }): McpToolInfo {
  return {
    name: tool.name,
    description: typeof tool.description === 'string' ? tool.description : '',
    inputSchema:
      typeof tool.inputSchema === 'object' && tool.inputSchema !== null
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: 'object', properties: {} },
  };
}

function mapContent(result: { content?: unknown }): McpContent[] {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const out: McpContent[] = [];
  for (const raw of blocks) {
    if (typeof raw !== 'object' || raw === null) continue;
    const block = raw as Record<string, unknown>;
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      out.push({ type: 'text', text: block['text'] });
    } else if (block['type'] === 'image' && typeof block['mimeType'] === 'string' && typeof block['data'] === 'string') {
      out.push({ type: 'image', mimeType: block['mimeType'], data: block['data'] });
    } else {
      out.push({
        type: 'other',
        typeName: typeof block['type'] === 'string' ? block['type'] : 'unknown',
        ...(typeof block['uri'] === 'string' ? { uri: block['uri'] } : {}),
      });
    }
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 每个 server 全局一个连接：管理状态、工具缓存、重启与超时。
 * 所有连接与调用都各自 try/catch，一个 server 的失败不影响其他 server。
 */
export class McpManager {
  private readonly opts: McpManagerOptions;
  private readonly entries = new Map<string, Entry>();
  private order: string[] = [];
  private stopping = false;

  constructor(options: McpManagerOptions) {
    this.opts = options;
  }

  states(): McpServerState[] {
    return this.order
      .map((id) => this.entries.get(id))
      .filter((entry): entry is Entry => entry !== undefined)
      .map((entry) => ({
        id: entry.config.id,
        status: entry.status,
        error: entry.error,
        tools: entry.tools.map((tool) => ({ ...tool })),
      }));
  }

  private emitStatus(entry: Entry): void {
    this.opts.emit({
      type: 'mcp_status',
      serverId: entry.config.id,
      status: entry.status,
      error: entry.error === null ? null : this.redact(entry.error),
    });
  }

  private redact(text: string): string {
    return this.opts.redact === undefined ? text : this.opts.redact(text);
  }

  private async reload(): Promise<void> {
    const servers = await this.opts.loadServers();
    this.order = servers.map((s) => s.id);
    for (const server of servers) {
      const existing = this.entries.get(server.id);
      if (existing === undefined) {
        this.entries.set(server.id, {
          config: server,
          status: 'stopped',
          error: null,
          tools: [],
          client: null,
          transport: null,
          restartCount: 0,
          generation: 0,
          intentional: false,
        });
      } else {
        existing.config = server;
      }
    }
    for (const id of [...this.entries.keys()]) {
      if (!this.order.includes(id)) {
        await this.closeConnection(this.entries.get(id)!);
        this.entries.delete(id);
      }
    }
  }

  private setStatus(entry: Entry, status: McpStatus, error: string | null): void {
    entry.status = status;
    entry.error = error;
    this.emitStatus(entry);
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.reload();
    await this.reconcile();
  }

  /** 按 bot 启用列表对齐连接：停用的断开，重新启用的连上 */
  async reconcile(): Promise<void> {
    const enabled = await this.opts.enabledServerIds();
    const jobs: Promise<void>[] = [];
    for (const id of this.order) {
      const entry = this.entries.get(id);
      if (entry === undefined) continue;
      if (!enabled.has(id)) {
        if (entry.status !== 'stopped') await this.disconnect(id);
        continue;
      }
      if (entry.status === 'stopped') jobs.push(this.connectInternal(entry, false));
    }
    // 不等待全部完成：启动内核不被某个 server 卡住
    void Promise.allSettled(jobs);
  }

  async connect(id: string): Promise<void> {
    await this.reload();
    const entry = this.entries.get(id);
    if (entry === undefined) throw new Error(`MCP server 不存在：${id}`);
    entry.restartCount = 0;
    await this.connectInternal(entry, true);
  }

  private async connectInternal(
    entry: Entry,
    manual: boolean,
    oauthProvider?: OAuthClientProvider,
  ): Promise<void> {
    if (this.stopping) return;
    const generation = entry.generation + 1;
    entry.generation = generation;
    await this.closeConnection(entry);
    entry.intentional = false;
    if (manual) entry.restartCount = 0;
    this.setStatus(entry, 'connecting', null);

    const transport = this.createTransport(entry.config, generation, oauthProvider);
    if (transport === null) {
      this.setStatus(entry, 'failed', `工作目录不存在：${entry.config.transport.type === 'stdio' ? entry.config.transport.cwd ?? '' : ''}`);
      return;
    }

    try {
      const client = new Client(CLIENT_INFO, {
        versionNegotiation: { mode: 'auto' },
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (error === null && tools !== null) {
                entry.tools = tools.map((tool) => toolInfo(tool));
                if (entry.status === 'connected') this.emitStatus(entry);
              }
            },
          },
        },
      });
      entry.client = client;
      entry.transport = transport;
      await withTimeout(client.connect(transport), this.opts.connectTimeoutMs ?? 30_000, '连接超时');
      if (entry.generation !== generation) return;
      // Client.connect 会设置自己的 onclose；包一层，保留它的清理逻辑
      const previousClose = (transport as unknown as { onclose?: () => void }).onclose;
      (transport as unknown as { onclose?: () => void }).onclose = () => {
        previousClose?.();
        this.handleClose(entry, generation);
      };
      const listed = await withTimeout(client.listTools(), this.opts.connectTimeoutMs ?? 30_000, '连接超时');
      entry.tools = (listed.tools ?? []).map((tool) => toolInfo(tool));
      this.setStatus(entry, 'connected', null);
    } catch (err) {
      if (entry.generation !== generation) return;
      if (this.stopping) return;
      // 先把状态定下来：连接超时后底层可能还在 spawn，清理不能拖住状态更新
      const message = errorText(err);
      if (/unauthorized|401|invalid_token|authorization required|needs_login/i.test(message)) {
        this.setStatus(entry, 'needs_login', '需要登录');
      } else {
        this.setStatus(entry, 'failed', this.redact(message));
      }
      void withTimeout(this.closeConnection(entry), 2_000, '清理超时').catch(() => undefined);
    }
  }

  private createTransport(
    config: McpServerConfig,
    _generation: number,
    oauthProvider?: OAuthClientProvider,
  ): Transport | null {
    if (this.opts.transportFactory !== undefined) return this.opts.transportFactory(config);
    if (config.transport.type === 'stdio') {
      const cwd = config.transport.cwd ?? this.opts.home;
      if (config.transport.cwd !== null && !existsSync(config.transport.cwd)) return null;
      return new StdioClientTransport({
        command: config.transport.command,
        args: [...config.transport.args],
        cwd,
        env: buildStdioEnv(config, this.opts.secretStore, this.opts.platform ?? process.platform, this.opts.env ?? process.env),
        stderr: 'pipe',
      });
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(config.transport.headers)) {
      if (value.secret) {
        const secret = this.opts.secretStore.get(`mcp:${config.id}:header:${name}`);
        if (secret !== null) headers[name] = secret;
      } else {
        headers[name] = value.value;
      }
    }
    const options: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {
      requestInit: { headers },
    };
    if (config.transport.auth === 'oauth') {
      const provider =
        oauthProvider ??
        this.opts.authProvider?.(config, 'http://127.0.0.1:0/callback');
      // 普通连接只在已有 token 时带上 authProvider，避免一启动就弹授权页
      if (provider !== undefined && (oauthProvider !== undefined || (provider as McpOAuthProvider).hasTokens())) {
        options.authProvider = provider;
      }
    }
    return new StreamableHTTPClientTransport(new URL(config.transport.url), options);
  }

  private handleClose(entry: Entry, generation: number): void {
    if (entry.generation !== generation || entry.intentional || this.stopping) return;
    const wasConnected = entry.status === 'connected';
    entry.client = null;
    entry.transport = null;
    if (!wasConnected) return;
    if (entry.restartCount >= (this.opts.maxRestarts ?? 3)) {
      this.setStatus(entry, 'failed', `已重启 ${this.opts.maxRestarts ?? 3} 次仍失败，请手动重连`);
      return;
    }
    entry.restartCount += 1;
    this.setStatus(entry, 'connecting', null);
    const timer = setTimeout(() => {
      if (!this.stopping && entry.generation === generation) void this.connectInternal(entry, false);
    }, this.opts.restartDelayMs ?? 500);
    timer.unref?.();
  }

  private oauthAuth(
    provider: OAuthClientProvider,
    options: { serverUrl: string; authorizationCode?: string; iss?: string },
  ): Promise<'AUTHORIZED' | 'REDIRECT'> {
    if (this.opts.oauthAuth !== undefined) return this.opts.oauthAuth(provider, options);
    return sdkAuth(provider, {
      serverUrl: options.serverUrl,
      ...(options.authorizationCode !== undefined ? { authorizationCode: options.authorizationCode } : {}),
      ...(options.iss !== undefined ? { iss: options.iss } : {}),
    });
  }

  /** 本机回调 + SDK OAuth：打开授权页，收到回调换取 token 后重连 */
  async login(id: string): Promise<void> {
    await this.reload();
    const entry = this.entries.get(id);
    if (entry === undefined) throw new Error(`MCP server 不存在：${id}`);
    if (entry.config.transport.type !== 'http' || entry.config.transport.auth !== 'oauth') {
      throw new Error('这个 MCP server 不需要登录');
    }
    if (this.opts.authProvider === undefined) throw new Error('没有可用的系统浏览器');
    const callback = await startOAuthCallback();
    try {
      const provider = this.opts.authProvider(entry.config, callback.redirectUrl);
      callback.setExpectedState(await provider.state());
      const first = await this.oauthAuth(provider, { serverUrl: entry.config.transport.url });
      if (first === 'REDIRECT') {
        const params = await callback.wait(this.opts.loginTimeoutMs ?? 300_000);
        const code = params.get('code');
        if (code === null) throw new Error(params.get('error') ?? '授权失败');
        const iss = params.get('iss') ?? undefined;
        await this.oauthAuth(provider, {
          serverUrl: entry.config.transport.url,
          authorizationCode: code,
          ...(iss !== undefined ? { iss } : {}),
        });
      }
      await callback.close().catch(() => undefined);
      await this.connectInternal(entry, true, provider);
    } catch (err) {
      await callback.close().catch(() => undefined);
      this.setStatus(entry, 'needs_login', this.redact(errorText(err)));
    }
  }

  async logout(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    const provider = this.opts.authProvider?.(entry.config, 'http://127.0.0.1:0/callback');
    if (provider !== undefined) await provider.logout();
    else await this.opts.secretStore.delete(`mcp:${id}:oauth`);
    await this.closeConnection(entry);
    this.setStatus(entry, 'needs_login', null);
  }

  async disconnect(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    await this.closeConnection(entry);
    this.setStatus(entry, 'stopped', null);
  }

  async refreshTools(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry?.client === null || entry?.client === undefined || entry.status !== 'connected') return;
    const listed = await withTimeout(entry.client.listTools(), entry.config.timeoutMs, '刷新工具超时');
    entry.tools = (listed.tools ?? []).map((tool) => toolInfo(tool));
    this.emitStatus(entry);
  }

  async call(
    id: string,
    tool: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<McpCallResult> {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.client === null || entry.status !== 'connected') {
      const name = entry?.config.name ?? id;
      return { content: [{ type: 'text', text: `MCP server 未连接：${name}` }], isError: true };
    }
    if (signal.aborted) throw new AbortedError([]);
    try {
      const result = await entry.client.callTool(
        { name: tool, arguments: input },
        { signal, timeout: entry.config.timeoutMs },
      );
      return { content: mapContent(result), isError: result.isError === true };
    } catch (err) {
      if (signal.aborted) throw new AbortedError([]);
      return { content: [{ type: 'text', text: `MCP 调用失败：${errorText(err)}` }], isError: true };
    }
  }

  private async closeConnection(entry: Entry): Promise<void> {
    entry.intentional = true;
    const client = entry.client;
    const transport = entry.transport;
    entry.client = null;
    entry.transport = null;
    const pid = transport instanceof StdioClientTransport ? transport.pid : null;
    try {
      await client?.close();
    } catch {
      // 已经断开
    }
    try {
      await transport?.close();
    } catch {
      // 已经断开
    }
    if (pid !== null && pid !== undefined) killTree(pid, this.opts.platform ?? process.platform);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const entry of this.entries.values()) {
      await this.closeConnection(entry);
      entry.status = 'stopped';
      entry.error = null;
    }
  }
}
