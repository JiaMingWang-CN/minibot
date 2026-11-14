import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import type { SecretStore } from '../secrets/store.ts';

export interface OAuthProviderOptions {
  serverId: string;
  serverName: string;
  redirectUrl: string;
  secretStore: SecretStore;
  openExternal?: (url: string) => Promise<void>;
}

interface StoredOAuth {
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  codeVerifier?: string;
  state?: string;
}

const KEY = (serverId: string): string => `mcp:${serverId}:oauth`;

/** OAuth 客户端信息与 token 存储：整份 JSON 只进密钥库 */
export class McpOAuthProvider implements OAuthClientProvider {
  readonly serverId: string;
  readonly serverName: string;
  readonly redirectUrl: string;
  private readonly secretStore: SecretStore;
  private readonly openExternal: ((url: string) => Promise<void>) | undefined;
  private data: StoredOAuth;

  constructor(options: OAuthProviderOptions) {
    this.serverId = options.serverId;
    this.serverName = options.serverName;
    this.redirectUrl = options.redirectUrl;
    this.secretStore = options.secretStore;
    this.openExternal = options.openExternal;
    const raw = options.secretStore.get(KEY(options.serverId));
    this.data = parseStored(raw);
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'minibot',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    } as OAuthClientMetadata;
  }

  /** 已有 token 才让普通连接带 authProvider，避免启动时突然弹授权页 */
  hasTokens(): boolean {
    return this.data.tokens !== undefined;
  }

  async clientInformation(_ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    return this.data.clientInformation;
  }

  async saveClientInformation(info: StoredOAuthClientInformation, _ctx?: OAuthClientInformationContext): Promise<void> {
    this.data.clientInformation = info;
    await this.persist();
  }

  async tokens(_ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    return this.data.tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens, _ctx?: OAuthClientInformationContext): Promise<void> {
    this.data.tokens = tokens;
    await this.persist();
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    this.data.codeVerifier = verifier;
    await this.persist();
  }

  async codeVerifier(): Promise<string> {
    return this.data.codeVerifier ?? '';
  }

  async state(): Promise<string> {
    if (this.data.state === undefined) {
      this.data.state = randomUUID();
      await this.persist();
    }
    return this.data.state;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (this.openExternal !== undefined) await this.openExternal(url.toString());
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all') this.data = {};
    else if (scope === 'client') delete this.data.clientInformation;
    else if (scope === 'tokens') delete this.data.tokens;
    else if (scope === 'verifier') delete this.data.codeVerifier;
    await this.persist();
  }

  async logout(): Promise<void> {
    this.data = {};
    await this.secretStore.delete(KEY(this.serverId));
  }

  private async persist(): Promise<void> {
    await this.secretStore.set(KEY(this.serverId), JSON.stringify(this.data));
  }
}

function parseStored(raw: string | null): StoredOAuth {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as StoredOAuth) : {};
  } catch {
    return {};
  }
}

export interface OAuthCallback {
  redirectUrl: string;
  /** 在打开授权页之前记下 SDK 生成的 state */
  setExpectedState(state: string): void;
  /** 等真正的回调；state 不匹配的回调返回 400 并继续等待 */
  wait(timeoutMs: number): Promise<URLSearchParams>;
  close(): Promise<void>;
}

const DONE_HTML =
  '<!doctype html><meta charset="utf-8"><title>minibot</title><p>授权完成，可以关闭此页面。</p>';

/** 一次性回调监听：只绑 127.0.0.1，只处理 GET /callback */
export async function startOAuthCallback(): Promise<OAuthCallback> {
  let expectedState: string | null = null;
  let resolveParams: ((params: URLSearchParams) => void) | undefined;
  let rejectParams: ((err: Error) => void) | undefined;
  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404);
      res.end();
      return;
    }
    const params = url.searchParams;
    if (expectedState === null || params.get('state') !== expectedState) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('state 不匹配');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(DONE_HTML);
    resolveParams?.(params);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const redirectUrl = `http://127.0.0.1:${port}/callback`;

  return {
    redirectUrl,
    setExpectedState(state) {
      expectedState = state;
    },
    wait(timeoutMs) {
      return new Promise<URLSearchParams>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('授权超时')), timeoutMs);
        timer.unref?.();
        resolveParams = (params) => {
          clearTimeout(timer);
          resolve(params);
        };
        rejectParams = (err) => {
          clearTimeout(timer);
          reject(err);
        };
      });
    },
    async close() {
      rejectParams?.(new Error('已关闭'));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
