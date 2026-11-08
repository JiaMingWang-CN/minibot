import type { PathClass } from '../tools/path-guard.ts';

export type ToolName = 'read_file' | 'write_file' | 'edit_file' | 'glob' | 'grep' | 'run_command';

const READ_ONLY = new Set<ToolName>(['read_file', 'glob', 'grep']);
const WRITE_TOOLS = new Set<ToolName>(['write_file', 'edit_file']);

export function decide(mode: 'ask' | 'auto', tool: ToolName, classes: PathClass[]): 'allow' | 'ask' {
  if (classes.includes('sensitive')) return 'ask';
  if (mode === 'auto') return 'allow';
  if (tool === 'run_command') return 'ask';
  if (READ_ONLY.has(tool)) {
    if (classes.length === 0) return 'ask';
    return classes.every((c) => c === 'workspace' || c === 'own_memory') ? 'allow' : 'ask';
  }
  if (WRITE_TOOLS.has(tool)) {
    if (classes.length === 0) return 'ask';
    return classes.every((c) => c === 'own_memory') ? 'allow' : 'ask';
  }
  return 'ask';
}
