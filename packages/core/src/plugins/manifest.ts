// 插件清单解析与变量替换（扩展第 4 期 Task 1）。
// 插件目录：minibot-plugin.json（必需）、mcp.json（可选）、skills/（可选，每个子目录一个 skill）。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseMcpJson, type McpDraftValue, type McpServerDraft } from '../mcp/config.ts';

export interface PluginConfigField {
  key: string;
  title: string;
  description: string;
  secret: boolean;
  required: boolean;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  config: PluginConfigField[];
}

export interface PluginBundle {
  manifest: PluginManifest;
  root: string;
  mcp: McpServerDraft[];
  skillDirs: string[];
  problems: string[];
}

export const PLUGIN_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CONFIG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const PLUGIN_NAME_RULE =
  '1–64 位小写字母、数字、连字符，不以连字符开头或结尾，不含 --';

/** 插件格式错误：携带全部原因，message 统一以“插件格式错误：”开头 */
export class PluginError extends Error {
  reasons: string[];

  constructor(reasons: string[]) {
    super(`插件格式错误：${reasons.join('；')}`);
    this.name = 'PluginError';
    this.reasons = reasons;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validPluginName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && PLUGIN_NAME_RE.test(name);
}

interface ParsedManifest {
  manifest: PluginManifest;
  reasons: string[];
}

function parseManifest(raw: unknown): ParsedManifest {
  const reasons: string[] = [];
  if (!isRecord(raw)) {
    return {
      manifest: { name: '', version: '', description: '', config: [] },
      reasons: ['minibot-plugin.json 不是 JSON 对象'],
    };
  }
  const name = typeof raw['name'] === 'string' ? raw['name'] : '';
  if (name.length === 0) reasons.push('缺少 name');
  else if (!validPluginName(name)) reasons.push(`name 不合规：${PLUGIN_NAME_RULE}`);

  const version = typeof raw['version'] === 'string' ? raw['version'] : '';
  if (version.length === 0) reasons.push('缺少 version');

  const description = typeof raw['description'] === 'string' ? raw['description'] : '';
  if (description.length === 0) reasons.push('缺少 description');

  const config: PluginConfigField[] = [];
  const seenKeys = new Set<string>();
  const rawConfig = raw['config'];
  if (rawConfig !== undefined) {
    if (!Array.isArray(rawConfig)) {
      reasons.push('config 必须是数组');
    } else {
      rawConfig.forEach((item, index) => {
        if (!isRecord(item)) {
          reasons.push(`config[${index}] 不是对象`);
          return;
        }
        const key = typeof item['key'] === 'string' ? item['key'] : '';
        if (!CONFIG_KEY_RE.test(key)) {
          reasons.push(`config[${index}].key 不合规：必须以字母或下划线开头，只含字母、数字、下划线`);
          return;
        }
        if (seenKeys.has(key)) {
          reasons.push(`config 里重复的 key：${key}`);
          return;
        }
        seenKeys.add(key);
        if (typeof item['title'] !== 'string' || typeof item['description'] !== 'string') {
          reasons.push(`config 项 ${key} 的 title / description 必须是字符串`);
          return;
        }
        config.push({
          key,
          title: item['title'],
          description: item['description'],
          secret: item['secret'] === true,
          required: item['required'] === true,
        });
      });
    }
  }

  const manifest: PluginManifest = { name, version, description, config };
  if (typeof raw['author'] === 'string') manifest.author = raw['author'];
  if (typeof raw['homepage'] === 'string') manifest.homepage = raw['homepage'];
  return { manifest, reasons };
}

const SUBST_RE = /\$\{(?:PLUGIN_ROOT|config\.([A-Za-z_][A-Za-z0-9_]*))\}/g;

/** 收集一段字符串里引用的 config 键（单次扫描，不递归） */
function configRefs(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(SUBST_RE)) {
    if (match[1] !== undefined) out.push(match[1]);
  }
  return out;
}

/** 单次替换：${PLUGIN_ROOT} → 插件目录；${config.KEY} → 对应值。替换结果不再被扫描 */
function substitute(text: string, values: Record<string, string>, root: string): string {
  return text.replace(SUBST_RE, (_whole, key: string | undefined) => {
    if (key === undefined) return root;
    return values[key] ?? '';
  });
}

function substitutableStrings(draft: McpServerDraft): string[] {
  const t = draft.transport;
  if (t.type === 'stdio') {
    return [t.command, ...t.args, ...Object.values(t.env).map((v) => v.value)];
  }
  return [t.url, ...Object.values(t.headers).map((v) => v.value)];
}

function rewriteValues(
  values: Record<string, McpDraftValue>,
  root: string,
  secretKeys: Set<string>,
  given: Record<string, string>,
): Record<string, McpDraftValue> {
  const out: Record<string, McpDraftValue> = {};
  for (const [name, value] of Object.entries(values)) {
    const refsSecret = configRefs(value.value).some((key) => secretKeys.has(key));
    out[name] = { value: substitute(value.value, given, root), secret: value.secret || refsSecret };
  }
  return out;
}

export async function readPluginBundle(dir: string): Promise<PluginBundle> {
  const root = path.resolve(dir);
  const reasons: string[] = [];
  const problems: string[] = [];

  let manifestText: string;
  try {
    manifestText = await fs.readFile(path.join(root, 'minibot-plugin.json'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new PluginError(['缺少 minibot-plugin.json']);
    throw err;
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestText);
  } catch (err) {
    throw new PluginError([`minibot-plugin.json 不是有效的 JSON：${err instanceof Error ? err.message : String(err)}`]);
  }
  const parsed = parseManifest(rawManifest);
  reasons.push(...parsed.reasons);

  const declaredKeys = new Set(parsed.manifest.config.map((field) => field.key));

  const mcp: McpServerDraft[] = [];
  let mcpText: string | null = null;
  try {
    mcpText = await fs.readFile(path.join(root, 'mcp.json'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (mcpText !== null) {
    try {
      const parsedMcp = parseMcpJson(mcpText);
      mcp.push(...parsedMcp.servers);
      if (parsedMcp.ignored.length > 0) problems.push(`mcp.json 忽略了这些字段或 server：${parsedMcp.ignored.join(', ')}`);
    } catch (err) {
      reasons.push(`mcp.json 解析失败：${err instanceof Error ? err.message : String(err)}`);
    }
    const undeclared = new Set<string>();
    for (const draft of mcp) {
      for (const text of substitutableStrings(draft)) {
        for (const key of configRefs(text)) {
          if (!declaredKeys.has(key)) undeclared.add(key);
        }
      }
    }
    for (const key of undeclared) reasons.push(`mcp.json 引用了未声明的配置：${key}`);
  }

  const skillDirs: string[] = [];
  const skillsRoot = path.join(root, 'skills');
  try {
    const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(skillsRoot, entry.name);
      skillDirs.push(skillDir);
      try {
        await fs.access(path.join(skillDir, 'SKILL.md'));
      } catch {
        problems.push(`skill 目录缺少 SKILL.md：${entry.name}`);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (reasons.length > 0) throw new PluginError(reasons);
  return { manifest: parsed.manifest, root, mcp, skillDirs, problems };
}

export function resolvePluginServers(bundle: PluginBundle, values: Record<string, string>): McpServerDraft[] {
  const { root } = bundle;
  const secretKeys = new Set(bundle.manifest.config.filter((field) => field.secret).map((field) => field.key));
  return bundle.mcp.map((draft) => {
    const t = draft.transport;
    const transport: McpServerDraft['transport'] =
      t.type === 'stdio'
        ? {
            type: 'stdio',
            command: substitute(t.command, values, root),
            args: t.args.map((arg) => substitute(arg, values, root)),
            cwd: t.cwd === null ? root : substitute(t.cwd, values, root),
            env: rewriteValues(t.env, root, secretKeys, values),
          }
        : {
            type: 'http',
            url: substitute(t.url, values, root),
            headers: rewriteValues(t.headers, root, secretKeys, values),
            auth: t.auth,
          };
    return { name: draft.name, shortName: draft.shortName, transport, timeoutMs: draft.timeoutMs };
  });
}
