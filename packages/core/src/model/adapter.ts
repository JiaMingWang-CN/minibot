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
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
