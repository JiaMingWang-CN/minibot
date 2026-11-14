// 搜索引擎工具：选中哪家预装搜索插件，就把它已连接的 server 工具以 web 来源交给 bot（扩展第 4 期 Task 6）。

import type { Bot } from '../config/types.ts';
import type { ExternalTool, ExternalToolProvider, ExternalCallContext } from '../tools/catalog.ts';
import type { ToolOutput } from '../tools/types.ts';
import type { WebSettings } from '../extensions/store.ts';
import type { McpManager, McpToolInfo } from '../mcp/manager.ts';
import { mapMcpCallResult } from '../mcp/tools.ts';
import { pluginServerId } from '../plugins/registry.ts';
import { WEB_UNTRUSTED_NOTICE } from './web-tools.ts';

const DEFAULT_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };

/** 按 URL 抓取内容的工具名（fetch / extract / crawl） */
const FETCH_LIKE = /(^|[_-])(fetch|extract|crawl)([_-]|$)/i;

const ENGINE_NAME: Record<'deepseek' | 'tavily', string> = { deepseek: 'DeepSeek', tavily: 'Tavily' };

export function searchServerId(engine: 'deepseek' | 'tavily'): string {
  return pluginServerId(engine, engine);
}

export interface SearchToolProviderOptions {
  manager: McpManager;
  loadSettings: () => Promise<WebSettings> | WebSettings;
  isPluginEnabled: (name: string) => Promise<boolean> | boolean;
}

export class SearchToolProvider implements ExternalToolProvider {
  private readonly opts: SearchToolProviderOptions;

  constructor(options: SearchToolProviderOptions) {
    this.opts = options;
  }

  async toolsFor(bot: Bot): Promise<ExternalTool[]> {
    if (!bot.extensions.web) return [];
    const settings = await this.opts.loadSettings();
    const engine = settings.searchEngine;
    if (engine !== 'deepseek' && engine !== 'tavily') return [];
    if (!(await this.opts.isPluginEnabled(engine))) return [];
    const serverId = searchServerId(engine);
    const state = this.opts.manager.states().find((s) => s.id === serverId);
    if (state === undefined || state.status !== 'connected') return [];
    // 关闭“抓取网页”后，搜索引擎里抓取类的工具（如 deepseek_fetch）也不提供
    const tools = settings.fetchEnabled ? state.tools : state.tools.filter((info) => !FETCH_LIKE.test(info.name));
    return tools.map((info) => this.externalTool(engine, serverId, info));
  }

  private externalTool(engine: 'deepseek' | 'tavily', serverId: string, info: McpToolInfo): ExternalTool {
    const label = ENGINE_NAME[engine];
    return {
      spec: {
        name: info.name,
        description: info.description,
        parameters: info.inputSchema ?? DEFAULT_SCHEMA,
      },
      source: { kind: 'web' },
      summarize: (input) => {
        const main = typeof input['query'] === 'string' ? `query=${input['query']}` : typeof input['url'] === 'string' ? `url=${input['url']}` : '';
        return main.length > 0 ? `${label}：${info.name}（${main}）` : `${label}：${info.name}`;
      },
      preview: (input) => JSON.stringify(input, null, 2),
      run: async (input: Record<string, unknown>, ctx: ExternalCallContext): Promise<ToolOutput> => {
        const result = await this.opts.manager.call(serverId, info.name, input, ctx.signal);
        // 官方返回原样保留，只在开头加一行外部内容说明（设计 §5.2）
        return { content: `${WEB_UNTRUSTED_NOTICE}\n\n${mapMcpCallResult(result)}`, isError: result.isError };
      },
    };
  }
}
