import type { PathClass } from '../tools/path-guard.ts';
import type { ApprovalMode } from '../config/types.ts';

export type ToolName = 'read_file' | 'write_file' | 'edit_file' | 'glob' | 'grep' | 'run_command';

const READ_ONLY = new Set<ToolName>(['read_file', 'glob', 'grep']);
const WRITE_TOOLS = new Set<ToolName>(['write_file', 'edit_file']);

export function decide(mode: ApprovalMode, tool: ToolName, classes: PathClass[]): 'allow' | 'ask' {
  if (classes.includes('sensitive')) return 'ask';
  if (mode === 'auto') return 'allow';
  if (tool === 'run_command') return 'ask';
  if (classes.length === 0) return 'ask';
  if (READ_ONLY.has(tool)) {
    return classes.every((c) => c === 'workspace' || c === 'own_memory') ? 'allow' : 'ask';
  }
  if (WRITE_TOOLS.has(tool)) {
    const allowed: PathClass[] = mode === 'edits' ? ['workspace', 'own_memory'] : ['own_memory'];
    return classes.every((c) => allowed.includes(c)) ? 'allow' : 'ask';
  }
  return 'ask';
}

// 管道、重定向、串联、变量、子命令、换行：PowerShell 与 bash 里都能改变命令含义，不能按原文放行
const SHELL_META = /[|&;<>$`(){}\r\n]/;

/** 只有不含任何 shell 元字符的单条命令才能加入“总是允许” */
export function isSimpleCommand(command: string): boolean {
  return command.trim().length > 0 && !SHELL_META.test(command);
}

/**
 * 外部工具的审批判断（spec §5.1）：
 * web：ask 档要问，edits / auto 放行；mcp：ask / edits 都要问，只有 auto 放行。
 * MCP server 自报的 readOnlyHint 等标注不参与这里的判断。
 */
export function decideExternal(mode: ApprovalMode, kind: 'web' | 'mcp'): 'allow' | 'ask' {
  if (mode === 'auto') return 'allow';
  if (kind === 'web') return mode === 'edits' ? 'allow' : 'ask';
  return 'ask';
}

/** 内置于内核、直接放行、不经过路径分类与审批的工具（load_skill） */
export function isDirectTool(name: string): boolean {
  return name === 'load_skill';
}
