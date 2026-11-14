import type { ExtensionsFile } from '../extensions/store.ts';
import { loadExtensions, saveExtensions } from '../extensions/store.ts';
import type { DataPaths } from '../paths.ts';

export type McpValue = { secret: false; value: string } | { secret: true };

export type McpTransportConfig =
  | {
      type: 'stdio';
      command: string;
      args: string[];
      cwd: string | null;
      env: Record<string, McpValue>;
    }
  | {
      type: 'http';
      url: string;
      headers: Record<string, McpValue>;
      auth: 'none' | 'oauth';
    };

export interface McpServerConfig {
  id: string;
  name: string;
  shortName: string;
  transport: McpTransportConfig;
  timeoutMs: number;
  origin: { kind: 'user' } | { kind: 'plugin'; pluginId: string };
}

export interface McpDraftValue {
  value: string;
  secret: boolean;
}

export type McpTransportDraft =
  | {
      type: 'stdio';
      command: string;
      args: string[];
      cwd: string | null;
      env: Record<string, McpDraftValue>;
    }
  | {
      type: 'http';
      url: string;
      headers: Record<string, McpDraftValue>;
      auth: 'none' | 'oauth';
    };

/** 未分配 id、值未分 secret 的草稿；用户在确认对话框里核对后再落盘 */
export interface McpServerDraft {
  name: string;
  shortName: string;
  transport: McpTransportDraft;
  timeoutMs: number;
}

export interface SecretEntry {
  key: string;
  value: string;
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|AUTH/i;
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** 从名字生成 server 短名：只保留 [a-zA-Z0-9_-]，其余换 _，截到 20 字符 */
export function shortNameFrom(name: string): string {
  const mapped = Array.from(name)
    .map((ch) => (/[a-zA-Z0-9_-]/.test(ch) ? ch : '_'))
    .join('')
    .slice(0, 20);
  return mapped.length > 0 ? mapped : 'mcp';
}

export function normalizeTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function draftValues(raw: unknown): Record<string, McpDraftValue> {
  const out: Record<string, McpDraftValue> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    out[key] = { value: String(value), secret: isSecretName(key) };
  }
  return out;
}

/** 解析常见的 `{"mcpServers": {...}}` 配置；不支持的字段名收进 ignored */
export function parseMcpJson(text: string): { servers: McpServerDraft[]; ignored: string[] } {
  const parsed: unknown = JSON.parse(text);
  const servers: McpServerDraft[] = [];
  const ignored = new Set<string>();
  if (!isRecord(parsed) || !isRecord(parsed['mcpServers'])) {
    throw new Error('JSON 里没有 mcpServers 对象');
  }
  for (const [name, raw] of Object.entries(parsed['mcpServers'])) {
    if (!isRecord(raw)) {
      ignored.add(name);
      continue;
    }
    if (raw['type'] === 'sse') {
      ignored.add(name);
      continue;
    }
    const recognized = new Set(['type', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'auth']);
    for (const key of Object.keys(raw)) if (!recognized.has(key)) ignored.add(key);

    if (typeof raw['command'] === 'string') {
      const args = Array.isArray(raw['args']) ? raw['args'].filter((a): a is string => typeof a === 'string') : [];
      servers.push({
        name,
        shortName: shortNameFrom(name),
        transport: {
          type: 'stdio',
          command: raw['command'],
          args,
          cwd: typeof raw['cwd'] === 'string' && raw['cwd'].length > 0 ? raw['cwd'] : null,
          env: draftValues(raw['env']),
        },
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      continue;
    }
    if (typeof raw['url'] === 'string') {
      servers.push({
        name,
        shortName: shortNameFrom(name),
        transport: {
          type: 'http',
          url: raw['url'],
          headers: draftValues(raw['headers']),
          auth: raw['auth'] === 'oauth' ? 'oauth' : 'none',
        },
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      continue;
    }
    ignored.add(name);
  }
  return { servers, ignored: [...ignored] };
}

/** 校验草稿的结构：名称、transport 类型、stdio 命令、http 地址（只允许 http/https） */
export function assertValidDraft(draft: McpServerDraft): void {
  if (typeof draft?.name !== 'string' || draft.name.trim().length === 0) throw new Error('MCP server 名称不能为空');
  const transport = draft.transport as { type?: unknown; command?: unknown; url?: unknown } | undefined;
  if (transport?.type === 'stdio') {
    if (typeof transport.command !== 'string' || transport.command.trim().length === 0) throw new Error('stdio 的启动命令不能为空');
  } else if (transport?.type === 'http') {
    let parsed: URL | null = null;
    try {
      parsed = new URL(String(transport.url));
    } catch {
      parsed = null;
    }
    if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new Error('http 地址必须是合法的 http:// 或 https:// 地址');
    }
  } else {
    throw new Error('MCP server 的传输方式必须是 stdio 或 http');
  }
}

/** 把草稿变成可保存的配置，并把 secret 值单独返回（只进密钥库） */
export function materializeServer(id: string, draft: McpServerDraft): { config: McpServerConfig; secrets: SecretEntry[] } {
  const secrets: SecretEntry[] = [];
  let transport: McpTransportConfig;
  if (draft.transport.type === 'stdio') {
    const env: Record<string, McpValue> = {};
    for (const [name, value] of Object.entries(draft.transport.env)) {
      if (value.secret) {
        env[name] = { secret: true };
        secrets.push({ key: `mcp:${id}:env:${name}`, value: value.value });
      } else {
        env[name] = { secret: false, value: value.value };
      }
    }
    transport = {
      type: 'stdio',
      command: draft.transport.command,
      args: [...draft.transport.args],
      cwd: draft.transport.cwd,
      env,
    };
  } else {
    const headers: Record<string, McpValue> = {};
    for (const [name, value] of Object.entries(draft.transport.headers)) {
      if (value.secret) {
        headers[name] = { secret: true };
        secrets.push({ key: `mcp:${id}:header:${name}`, value: value.value });
      } else {
        headers[name] = { secret: false, value: value.value };
      }
    }
    transport = { type: 'http', url: draft.transport.url, headers, auth: draft.transport.auth };
  }
  return {
    config: {
      id,
      name: draft.name,
      shortName: draft.shortName.length > 0 ? draft.shortName : shortNameFrom(draft.name),
      transport,
      timeoutMs: normalizeTimeout(draft.timeoutMs),
      origin: { kind: 'user' },
    },
    secrets,
  };
}

export function assertUniqueServerName(servers: McpServerConfig[], name: string): void {
  if (servers.some((s) => s.name === name)) throw new Error('已有同名的 MCP server');
}

export async function loadMcpServers(p: DataPaths): Promise<McpServerConfig[]> {
  const file: ExtensionsFile = await loadExtensions(p);
  return Array.isArray(file.mcpServers) ? file.mcpServers : [];
}

/** 调用方要自己持有 extensions.json 的锁（读改写在同一把锁里） */
export async function saveMcpServers(p: DataPaths, servers: McpServerConfig[]): Promise<void> {
  const file = await loadExtensions(p);
  file.mcpServers = servers;
  await saveExtensions(p, file);
}
