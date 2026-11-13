import { createHash } from 'node:crypto';
import type { Bot } from '../config/types.ts';
import type { ExternalTool, ExternalToolProvider, ExternalCallContext } from '../tools/catalog.ts';
import type { ToolOutput } from '../tools/types.ts';
import type { McpCallResult, McpManager, McpToolInfo } from './manager.ts';
import type { McpServerConfig } from './config.ts';

const DEFAULT_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };

/** 工具对模型的名字：<shortName>__<tool>，非法字符换 _；超长或冲突时截短并加短哈希 */
export function toolNameFor(shortName: string, tool: string, taken: Set<string>): string {
  const base = `${shortName}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (base.length <= 64 && !taken.has(base)) {
    taken.add(base);
    return base;
  }
  const hash = createHash('sha256').update(`${shortName}\0${tool}`).digest('hex').slice(0, 6);
  let suffix = `_${hash}`;
  let name = `${base.slice(0, Math.max(0, 64 - suffix.length))}${suffix}`;
  let attempt = 1;
  while (taken.has(name)) {
    suffix = `_${hash}${attempt}`;
    name = `${base.slice(0, Math.max(0, 64 - suffix.length))}${suffix}`;
    attempt += 1;
  }
  taken.add(name);
  return name;
}

/** MCP 结果映射成一段文字：text 空行拼接，image 转文字占位，resource 转 [资源：uri] */
export function mapMcpCallResult(result: McpCallResult): string {
  return result.content
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'image') return `[图片：${block.mimeType}，暂不支持传给模型]`;
      if (block.typeName === 'resource' || block.typeName === 'resource_link') {
        return `[资源：${block.uri ?? ''}]`;
      }
      return `[不支持的内容类型：${block.typeName}]`;
    })
    .join('\n\n');
}

export interface McpToolProviderOptions {
  manager: McpManager;
  loadServers: () => Promise<McpServerConfig[]>;
}

/** 把已连接的 MCP server 的工具按 bot 启用列表转成外部工具 */
export class McpToolProvider implements ExternalToolProvider {
  private readonly manager: McpManager;
  private readonly loadServers: () => Promise<McpServerConfig[]>;

  constructor(options: McpToolProviderOptions) {
    this.manager = options.manager;
    this.loadServers = options.loadServers;
  }

  async toolsFor(bot: Bot): Promise<ExternalTool[]> {
    const enabled = new Set(bot.extensions.mcpServers);
    if (enabled.size === 0) return [];
    const configs = await this.loadServers();
    const states = new Map(this.manager.states().map((state) => [state.id, state]));
    const taken = new Set<string>();
    const tools: ExternalTool[] = [];
    for (const config of configs) {
      if (!enabled.has(config.id)) continue;
      const state = states.get(config.id);
      if (state === undefined || state.status !== 'connected') continue;
      for (const info of state.tools) {
        const name = toolNameFor(config.shortName, info.name, taken);
        tools.push(this.externalTool(config, info, name));
      }
    }
    return tools;
  }

  private externalTool(config: McpServerConfig, info: McpToolInfo, name: string): ExternalTool {
    return {
      spec: {
        name,
        description: `[MCP · ${config.name}] ${info.description}`.trim(),
        parameters: info.inputSchema ?? DEFAULT_SCHEMA,
      },
      source: {
        kind: 'mcp',
        serverId: config.id,
        serverName: config.name,
        toolName: info.name,
      },
      summarize: () => `调用 MCP 工具：${config.name} / ${info.name}`,
      preview: (input) => JSON.stringify(input, null, 2),
      run: async (input: Record<string, unknown>, ctx: ExternalCallContext): Promise<ToolOutput> => {
        const result = await this.manager.call(config.id, info.name, input, ctx.signal);
        return { content: mapMcpCallResult(result), isError: result.isError };
      },
    };
  }
}
