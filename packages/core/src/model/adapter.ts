import type { ApiFormat, ThinkingLevel } from '../config/types.ts';
import type { Block, StoredMessage } from './types.ts';
import type { ResultAccumulator } from './accumulator.ts';
import type { SseEvent } from './sse.ts';
import { CANCELLED_TEXT } from '../db/messages.ts';

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: StoredMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  thinkingLevel: ThinkingLevel | null;
  /** 图片附件 id → base64 数据；消息里的 image 块按 id 取用，取不到时发文字占位 */
  attachments?: Record<string, string>;
}

export const MISSING_IMAGE_TEXT = '[图片已丢失]';

export function imagesOf(blocks: Block[]): Extract<Block, { type: 'image' }>[] {
  return blocks.filter((b): b is Extract<Block, { type: 'image' }> => b.type === 'image');
}

export interface Adapter {
  format: ApiFormat;
  path: string;
  headers(apiKey: string): Record<string, string>;
  body(req: ModelRequest): unknown;
  parse(events: AsyncIterable<SseEvent>, acc: ResultAccumulator, model: string): Promise<void>;
}

/** 工具调用的参数无法解析为 JSON 对象时，tool_use 的 input 里放原始文本的这个键，由工具执行层回一条错误结果 */
export const INVALID_ARGS_KEY = '__invalid_arguments';

/**
 * 交给模型的历史：去掉提示消息和空的 assistant 消息。
 * 兜底：assistant 的 tool_use 缺少对应结果（如结果入库前出错）时补一条已取消的结果，
 * 否则供应商会对该线程之后的每次请求都报 400。
 */
export function historyForModel(messages: StoredMessage[]): StoredMessage[] {
  const kept = messages.filter(
    (m) => m.kind !== 'notice' && !(m.role === 'assistant' && m.blocks.length === 0),
  );
  const out: StoredMessage[] = [];
  for (const [i, message] of kept.entries()) {
    out.push(message);
    if (message.role !== 'assistant') continue;
    const ids = message.blocks.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []));
    if (ids.length === 0) continue;
    const next = kept[i + 1];
    const answered = new Set(
      next?.role === 'user'
        ? next.blocks.flatMap((b) => (b.type === 'tool_result' ? [b.toolUseId] : []))
        : [],
    );
    const missing = ids.filter((id) => !answered.has(id));
    if (missing.length === 0) continue;
    out.push({
      id: message.id,
      threadId: message.threadId,
      role: 'user',
      blocks: missing.map((toolUseId) => ({
        type: 'tool_result',
        toolUseId,
        content: CANCELLED_TEXT,
        status: 'cancelled',
      })),
      kind: null,
      interrupted: false,
      createdAt: message.createdAt,
    });
  }
  return out;
}

export function keepReasoning(
  b: Block,
  format: ApiFormat,
  model: string,
): b is Extract<Block, { type: 'reasoning' }> & {
  opaque: { format: ApiFormat; model: string; data: unknown };
} {
  return (
    b.type === 'reasoning' &&
    b.opaque !== undefined &&
    b.opaque.format === format &&
    b.opaque.model === model
  );
}

export function textOf(blocks: Block[]): string {
  return blocks
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'skill') return `已加载 skill：${b.name}\n\n${b.text}`;
      return null;
    })
    .filter((x): x is string => x !== null)
    .join('\n');
}
