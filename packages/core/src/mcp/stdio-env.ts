import type { McpServerConfig } from './config.ts';
import type { SecretStore } from '../secrets/store.ts';

const WINDOWS_VARS = [
  'SystemRoot',
  'SystemDrive',
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'PROGRAMDATA',
];

const LINUX_VARS = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'];

function pick(base: NodeJS.ProcessEnv, name: string, caseInsensitive: boolean): string | undefined {
  if (!caseInsensitive) return base[name];
  const key = Object.keys(base).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : base[key];
}

/**
 * stdio 子进程环境：最小系统变量 + 配置声明的变量；敏感值从密钥库取。
 * 不继承内核进程的其余环境，避免把 API Key 等带进 server。
 */
export function buildStdioEnv(
  config: McpServerConfig,
  secretStore: SecretStore,
  platform: NodeJS.Platform = process.platform,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  const names = platform === 'win32' ? WINDOWS_VARS : LINUX_VARS;
  for (const name of names) {
    const value = pick(baseEnv, name, platform === 'win32');
    if (value !== undefined) env[name] = value;
  }
  const transport = config.transport;
  if (transport.type !== 'stdio') return env;
  for (const [name, value] of Object.entries(transport.env)) {
    if (value.secret) {
      const secret = secretStore.get(`mcp:${config.id}:env:${name}`);
      if (secret !== null) env[name] = secret;
    } else {
      env[name] = value.value;
    }
  }
  return env;
}
