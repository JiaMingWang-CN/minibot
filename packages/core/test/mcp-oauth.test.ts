import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { dataPaths } from '../src/paths.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import { SecretStore, type KeyCrypto } from '../src/secrets/store.ts';
import type { McpServerConfig } from '../src/mcp/config.ts';
import { McpManager } from '../src/mcp/manager.ts';
import { McpOAuthProvider, startOAuthCallback } from '../src/mcp/oauth.ts';

function fakeCrypto(): KeyCrypto {
  return {
    backend: () => 'os',
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decrypt: (buf) => Buffer.from(buf.toString('utf8').slice(4), 'base64').toString('utf8'),
  };
}

async function secretStore(): Promise<{ store: SecretStore; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-oauth-'));
  const store = new SecretStore(dataPaths(root).secrets, fakeCrypto(), new SecretSet());
  await store.load();
  return { store, root };
}

function httpConfig(id: string): McpServerConfig {
  return {
    id,
    name: 'OAuth Server',
    shortName: id,
    transport: { type: 'http', url: 'https://mcp.example/mcp', headers: {}, auth: 'oauth' },
    timeoutMs: 10_000,
    origin: { kind: 'user' },
  };
}

test('provider：客户端信息、token、code verifier 只存密钥库并可重新读回', async () => {
  const { store } = await secretStore();
  const provider = new McpOAuthProvider({
    serverId: 's1',
    serverName: 'S1',
    redirectUrl: 'http://127.0.0.1:1234/callback',
    secretStore: store,
  });
  await provider.saveClientInformation({ client_id: 'c1', redirect_uris: ['http://127.0.0.1:1234/callback'] } as never);
  await provider.saveTokens({ access_token: 'tok-123', token_type: 'Bearer', refresh_token: 'ref-123' } as never);
  await provider.saveCodeVerifier('verifier-1');
  assert.equal(provider.hasTokens(), true);

  const reread = new McpOAuthProvider({
    serverId: 's1',
    serverName: 'S1',
    redirectUrl: 'http://127.0.0.1:1234/callback',
    secretStore: store,
  });
  assert.equal((await reread.tokens())?.access_token, 'tok-123');
  assert.equal(await reread.codeVerifier(), 'verifier-1');
  const raw = store.get('mcp:s1:oauth');
  assert.ok(raw !== null && raw.includes('tok-123'));
  await reread.logout();
  assert.equal(store.get('mcp:s1:oauth'), null);
});

test('回调监听：state 不匹配返回 400 且继续等，正确回调后收到 code', async () => {
  const cb = await startOAuthCallback();
  try {
    cb.setExpectedState('good');
    const waiting = cb.wait(2000);
    const bad = await fetch(`${cb.redirectUrl}?state=bad&code=x`);
    assert.equal(bad.status, 400);
    const good = await fetch(`${cb.redirectUrl}?state=good&code=abc&iss=https%3A%2F%2Fas.example`);
    assert.equal(good.status, 200);
    const params = await waiting;
    assert.equal(params.get('code'), 'abc');
    assert.equal(params.get('iss'), 'https://as.example');
  } finally {
    await cb.close();
  }
});

test('回调监听：超时后关闭并报授权超时', async () => {
  const cb = await startOAuthCallback();
  cb.setExpectedState('good');
  await assert.rejects(cb.wait(100), /授权超时/);
  await cb.close();
});

test('login：模拟浏览器完成回调后换取 token 并连上 server', async () => {
  const { store, root } = await secretStore();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: 'oauth-fixture', version: '1.0.0' });
  server.registerTool('echo', { description: 'echo', inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: 'text', text: `echo:${text}` }],
  }));
  await server.connect(serverTransport);

  const manager = new McpManager({
    loadServers: async () => [httpConfig('s1')],
    enabledServerIds: async () => new Set(['s1']),
    secretStore: store,
    emit: () => {},
    home: root,
    authProvider: (serverConfig, redirectUrl) =>
      new McpOAuthProvider({
        serverId: serverConfig.id,
        serverName: serverConfig.name,
        redirectUrl,
        secretStore: store,
      }),
    oauthAuth: async (provider, options) => {
      const p = provider as McpOAuthProvider;
      if (options.authorizationCode === undefined) {
        const state = await p.state();
        const callback = new URL(p.redirectUrl);
        callback.searchParams.set('state', state);
        callback.searchParams.set('code', 'code-1');
        setTimeout(() => void fetch(callback), 10);
        await p.redirectToAuthorization(new URL('https://as.example/authorize'));
        return 'REDIRECT';
      }
      await provider.saveTokens({ access_token: 'tok-1', token_type: 'Bearer', refresh_token: 'ref-1' } as never);
      return 'AUTHORIZED';
    },
    loginTimeoutMs: 3000,
    transportFactory: () => clientTransport,
  });

  await manager.login('s1');
  assert.equal(manager.states()[0]?.status, 'connected');
  assert.ok(manager.states()[0]?.tools.some((tool) => tool.name === 'echo'));
  const result = await manager.call('s1', 'echo', { text: 'hi' }, new AbortController().signal);
  assert.equal(result.isError, false);
  assert.equal(result.content[0]!.type === 'text' ? result.content[0]!.text : '', 'echo:hi');
  assert.ok(store.get('mcp:s1:oauth')?.includes('tok-1'));
  await manager.stop();
});

test('login 超时：状态回到 needs_login，错误为授权超时', async () => {
  const { store, root } = await secretStore();
  const manager = new McpManager({
    loadServers: async () => [httpConfig('s2')],
    enabledServerIds: async () => new Set(),
    secretStore: store,
    emit: () => {},
    home: root,
    authProvider: (serverConfig, redirectUrl) =>
      new McpOAuthProvider({
        serverId: serverConfig.id,
        serverName: serverConfig.name,
        redirectUrl,
        secretStore: store,
      }),
    oauthAuth: async (provider) => {
      await (provider as McpOAuthProvider).redirectToAuthorization(new URL('https://as.example/authorize'));
      return 'REDIRECT';
    },
    loginTimeoutMs: 100,
  });
  await manager.start();
  await manager.login('s2');
  const state = manager.states().find((s) => s.id === 's2')!;
  assert.equal(state.status, 'needs_login');
  assert.equal(state.error, '授权超时');
});

test('logout：删除密钥库里的 oauth 条目，状态回到 needs_login', async () => {
  const { store, root } = await secretStore();
  const provider = new McpOAuthProvider({
    serverId: 's3',
    serverName: 'S3',
    redirectUrl: 'http://127.0.0.1:1/callback',
    secretStore: store,
  });
  await provider.saveTokens({ access_token: 'tok-3', token_type: 'Bearer' } as never);

  const manager = new McpManager({
    loadServers: async () => [httpConfig('s3')],
    enabledServerIds: async () => new Set(),
    secretStore: store,
    emit: () => {},
    home: root,
    authProvider: (serverConfig, redirectUrl) =>
      new McpOAuthProvider({
        serverId: serverConfig.id,
        serverName: serverConfig.name,
        redirectUrl,
        secretStore: store,
      }),
  });
  await manager.start();
  await manager.logout('s3');
  assert.equal(store.get('mcp:s3:oauth'), null);
  assert.equal(manager.states().find((s) => s.id === 's3')?.status, 'needs_login');
});
