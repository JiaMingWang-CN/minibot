import type { ApiFormat } from '../config/types.ts';
import { newToolUseId } from './ids.ts';
import { INVALID_ARGS_KEY } from './adapter.ts';
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
      /** 参数 JSON 文本，到取结果时才解析 */
      args: string;
    };

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 从文本开头取出第一个完整的 JSON 对象文本；还没收完整返回 null */
function firstObjectText(text: string): string | null {
  let i = 0;
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  if (text[i] !== '{') return null;
  let depth = 0;
  let inString = false;
  for (let j = i; j < text.length; j += 1) {
    const c = text[j]!;
    if (inString) {
      if (c === '\\') j += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return null;
}

/** 解析工具参数：空按 {}；解析不出对象返回 undefined。完整对象之后多出来的内容忽略 */
function parseToolArgs(args: string): Record<string, unknown> | undefined {
  if (args.trim().length === 0) return {};
  try {
    return asObject(JSON.parse(args));
  } catch {
    const head = firstObjectText(args);
    if (head === null) return undefined;
    try {
      return asObject(JSON.parse(head));
    } catch {
      return undefined;
    }
  }
}

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
    // 已挂上 opaque 的推理块算收尾，新的推理文字另起一块
    if (last?.kind === 'reasoning' && last.opaque === undefined) last.text += t;
    else this.parts.push({ kind: 'reasoning', text: t });
    this.onDelta({ type: 'reasoning', text: t });
  }

  reasoningOpaque(o: { format: ApiFormat; model: string; data: unknown }): void {
    // 挂到最近一个还没有 opaque 的推理块上，不覆盖前面已有的；没有就新建一个空文字的
    for (let i = this.parts.length - 1; i >= 0; i -= 1) {
      const part = this.parts[i];
      if (part?.kind === 'reasoning' && part.opaque === undefined) {
        part.opaque = o;
        return;
      }
    }
    this.parts.push({ kind: 'reasoning', text: '', opaque: o });
  }

  toolStart(key: string, name: string): void {
    if (this.parts.some((p) => p.kind === 'tool' && p.key === key)) return;
    this.parts.push({ kind: 'tool', key, id: newToolUseId(), name, args: '' });
  }

  /** 参数增量：只追加，到取结果时才解析（每个增量都解析整串是平方复杂度） */
  toolArgs(key: string, chunk: string): void {
    const part = this.parts.find((p) => p.kind === 'tool' && p.key === key);
    if (part === undefined || part.kind !== 'tool') return;
    part.args += chunk;
  }

  /** 适配器拿到的是完整参数（如 Responses 的 output_item.done）：直接替换已累积的，不重复追加 */
  toolArgsFull(key: string, args: string): void {
    const part = this.parts.find((p) => p.kind === 'tool' && p.key === key);
    if (part === undefined || part.kind !== 'tool') return;
    part.args = args;
  }

  stop(r: AssistantResult['stopReason']): void {
    this.stopReason = r;
  }

  usage(u: Partial<AssistantResult['usage']>): void {
    if (u.inputTokens !== undefined) this.usageValue.inputTokens = u.inputTokens;
    if (u.outputTokens !== undefined) this.usageValue.outputTokens = u.outputTokens;
    if (u.cachedInputTokens !== undefined) this.usageValue.cachedInputTokens = u.cachedInputTokens;
  }

  /** keepInvalid：参数解析不出对象的工具调用保留（正常结束时）；流中断时的 partial 里仍丢弃，保证“没产出就重试” */
  snapshot(keepInvalid = false): Block[] {
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
      } else {
        // 无参数的工具调用没有任何参数增量，按空对象处理而不是丢掉
        // 参数解析不出对象时保留该调用，把原文放进标记键，执行层回错误结果让模型重试
        const parsed = parseToolArgs(part.args);
        if (parsed !== undefined) blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: parsed });
        else if (keepInvalid) {
          const input = { [INVALID_ARGS_KEY]: part.args.slice(0, 500) };
          blocks.push({ type: 'tool_use', id: part.id, name: part.name, input });
        }
      }
    }
    return structuredClone(blocks);
  }

  result(): AssistantResult {
    return {
      blocks: this.snapshot(true),
      stopReason: this.stopReason,
      usage: { ...this.usageValue },
    };
  }
}
