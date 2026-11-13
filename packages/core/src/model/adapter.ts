import type { ApiFormat, ThinkingLevel } from '../config/types.ts';
import type { Block, StoredMessage } from './types.ts';
import type { ResultAccumulator } from './accumulator.ts';
import type { SseEvent } from './sse.ts';

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

export function historyForModel(messages: StoredMessage[]): StoredMessage[] {
  return messages.filter(
    (m) => m.kind !== 'notice' && !(m.role === 'assistant' && m.blocks.length === 0),
  );
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
