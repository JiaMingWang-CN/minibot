import type { ApiFormat } from '../config/types.ts';
import { newToolUseId } from './ids.ts';
import type { AssistantResult, Block, Delta } from './types.ts';

type ReasoningOpaque = { format: ApiFormat; model: string; data: unknown };

type Part =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string; opaque?: ReasoningOpaque }
  | {
      kind: 'tool';
      key: string;
      id: string;
      name: string;
      args: string;
      input?: Record<string, unknown>;
    };

export class ResultAccumulator {
  private onDelta: (d: Delta) => void;
  private parts: Part[] = [];
  private stopReason: AssistantResult['stopReason'] = 'end';
  private usageValue: AssistantResult['usage'] = { inputTokens: 0, outputTokens: 0 };

  constructor(onDelta: (d: Delta) => void) {
    this.onDelta = onDelta;
  }

  text(t: string): void {
    if (t.length === 0) return;
    const last = this.parts[this.parts.length - 1];
    if (last?.kind === 'text') last.text += t;
    else this.parts.push({ kind: 'text', text: t });
    this.onDelta({ type: 'text', text: t });
  }

  reasoning(t: string): void {
    if (t.length === 0) return;
    const last = this.parts[this.parts.length - 1];
    if (last?.kind === 'reasoning') last.text += t;
    else this.parts.push({ kind: 'reasoning', text: t });
    this.onDelta({ type: 'reasoning', text: t });
  }

  reasoningOpaque(o: { format: ApiFormat; model: string; data: unknown }): void {
    let found = false;
    for (let i = this.parts.length - 1; i >= 0; i -= 1) {
      const part = this.parts[i];
      if (part?.kind === 'reasoning') {
        part.opaque = o;
        found = true;
        break;
      }
    }
    if (!found) this.parts.push({ kind: 'reasoning', text: '', opaque: o });
  }

  toolStart(key: string, name: string): void {
    if (this.parts.some((p) => p.kind === 'tool' && p.key === key)) return;
    this.parts.push({ kind: 'tool', key, id: newToolUseId(), name, args: '' });
  }

  toolArgs(key: string, chunk: string): void {
    const part = this.parts.find((p) => p.kind === 'tool' && p.key === key);
    if (part === undefined || part.kind !== 'tool') return;
    if (part.input !== undefined) return;
    part.args += chunk;
    try {
      const parsed: unknown = JSON.parse(part.args);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        part.input = parsed as Record<string, unknown>;
      }
    } catch {
      // 参数还没接收完整
    }
  }

  stop(r: AssistantResult['stopReason']): void {
    this.stopReason = r;
  }

  usage(u: Partial<AssistantResult['usage']>): void {
    if (u.inputTokens !== undefined) this.usageValue.inputTokens = u.inputTokens;
    if (u.outputTokens !== undefined) this.usageValue.outputTokens = u.outputTokens;
    if (u.cachedInputTokens !== undefined) this.usageValue.cachedInputTokens = u.cachedInputTokens;
  }

  snapshot(): Block[] {
    const blocks: Block[] = [];
    for (const part of this.parts) {
      if (part.kind === 'text') {
        if (part.text.length > 0) blocks.push({ type: 'text', text: part.text });
      } else if (part.kind === 'reasoning') {
        if (part.text.length > 0 || part.opaque !== undefined) {
          const block: Block = { type: 'reasoning', text: part.text };
          if (part.opaque !== undefined) block.opaque = part.opaque;
          blocks.push(block);
        }
      } else if (part.input !== undefined) {
        blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input });
      }
    }
    return structuredClone(blocks);
  }

  result(): AssistantResult {
    return {
      blocks: this.snapshot(),
      stopReason: this.stopReason,
      usage: { ...this.usageValue },
    };
  }
}
