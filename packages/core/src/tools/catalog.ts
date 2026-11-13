import type { Bot } from '../config/types.ts';
import type { DiagLog } from '../diag/log.ts';
import type { ToolSpec } from '../model/adapter.ts';
import type { SkillInfo } from '../skills/skill.ts';
import { LOAD_SKILL_SPEC } from '../skills/load-skill.ts';
import { TOOL_SPECS } from './registry.ts';
import type { ToolOutput } from './types.ts';

/** 工具来源：内置、联网、某个 MCP server 的工具 */
export type ToolSource =
  | { kind: 'builtin' }
  | { kind: 'web' }
  | { kind: 'mcp'; serverId: string; serverName: string; toolName: string };

export type ExternalSource = Exclude<ToolSource, { kind: 'builtin' }>;

/** 执行外部工具时传给它的上下文；supportsImages 取当前模型是否支持图片 */
export interface ExternalCallContext {
  bot: Bot;
  threadId: string;
  signal: AbortSignal;
  supportsImages: boolean;
}

/** 外部工具：spec 给模型看；validate / summarize / preview / run 由各期接入的实现提供 */
export interface ExternalTool {
  spec: ToolSpec;
  source: ExternalSource;
  validate?(input: Record<string, unknown>): string | null;
  summarize(input: Record<string, unknown>): string;
  preview?(input: Record<string, unknown>): string | undefined;
  run(input: Record<string, unknown>, ctx: ExternalCallContext): Promise<ToolOutput>;
}

export interface ExternalToolProvider {
  toolsFor(bot: Bot): Promise<ExternalTool[]>;
}

/** 本轮工具快照：specs 是我们交给模型的完整列表，external 用来找非内置工具的实现，skills 是本轮可用的 skill */
export interface TurnToolset {
  specs: ToolSpec[];
  external(name: string): ExternalTool | undefined;
  skills: SkillInfo[];
}

const BUILTIN_NAMES = new Set(TOOL_SPECS.map((t) => t.name));

/** 内核持有一份；后续各期把联网 / MCP / 插件 / skill 的 provider 注册进来 */
export class ToolCatalog {
  private readonly providers: ExternalToolProvider[] = [];
  private readonly diag: () => DiagLog | undefined;

  constructor(diag?: () => DiagLog | undefined) {
    this.diag = diag ?? (() => undefined);
  }

  register(provider: ExternalToolProvider): void {
    this.providers.push(provider);
  }

  /** 内置工具在前，随后按注册顺序合并各 provider 的工具；重名（内置或已收录的外部工具）丢弃。
   *  有可用 skill 时追加内置工具 load_skill。 */
  async snapshot(bot: Bot, skills: SkillInfo[] = []): Promise<TurnToolset> {
    const specs: ToolSpec[] = [...TOOL_SPECS];
    const external = new Map<string, ExternalTool>();
    for (const provider of this.providers) {
      let tools: ExternalTool[];
      try {
        tools = await provider.toolsFor(bot);
      } catch {
        // 某个 provider 出错不影响其他工具；只记来源无关的警告，不记 server 名或错误原文
        this.diag()?.write('warn', 'tool', 'tool.provider_failed', {});
        continue;
      }
      for (const tool of tools) {
        const name = tool.spec.name;
        if (BUILTIN_NAMES.has(name)) continue;
        if (external.has(name)) {
          this.diag()?.write('warn', 'tool', 'tool.name_conflict', { tool: name });
          continue;
        }
        external.set(name, tool);
        specs.push(tool.spec);
      }
    }
    if (skills.length > 0) specs.push(LOAD_SKILL_SPEC);
    return { specs, external: (name: string) => external.get(name), skills };
  }
}
