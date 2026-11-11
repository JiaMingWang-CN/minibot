import type { ApiFormat } from '../config/types.ts';

export type Block =
  | { type: 'text'; text: string }
  | {
      type: 'reasoning';
      text: string;
      opaque?: { format: ApiFormat; model: string; data: unknown };
    }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      toolUseId: string;
      content: string;
      status: 'ok' | 'error' | 'denied' | 'cancelled';
    }
  /** 用户附带的图片；数据存在附件目录，消息里只存引用 */
  | { type: 'image'; id: string; mediaType: ImageMediaType };

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** 一次模型调用的用量；cachedInputTokens 只在供应商报告了缓存命中时才有（不报告不等于 0） */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export type MessageKind = 'summary' | 'notice' | null;

export interface StoredMessage {
  id: number;
  threadId: string;
  role: 'user' | 'assistant';
  blocks: Block[];
  kind: MessageKind;
  interrupted: boolean;
  createdAt: number;
  /** 产生这条 assistant 消息的模型调用用量 */
  usage?: Usage;
}

export type Delta = { type: 'text' | 'reasoning'; text: string };

export interface AssistantResult {
  blocks: Block[];
  stopReason: 'end' | 'tool_use' | 'max_tokens';
  usage: Usage;
}

export type ModelErrorKind =
  | 'auth'
  | 'not_found'
  | 'rate_limit'
  | 'server'
  | 'bad_request'
  | 'network'
  | 'stream';

export interface ModelErrorOptions {
  status?: number;
  partial?: Block[];
  cause?: unknown;
}

export class ModelError extends Error {
  kind: ModelErrorKind;
  status: number | undefined;
  partial: Block[];
  cause: unknown;

  constructor(kind: ModelErrorKind, message: string, opts: ModelErrorOptions = {}) {
    super(message);
    this.name = 'ModelError';
    this.kind = kind;
    this.status = opts.status;
    this.partial = opts.partial ?? [];
    this.cause = opts.cause;
  }
}

export class AbortedError extends Error {
  partial: Block[];

  constructor(partial: Block[] = [], message = '请求已中止') {
    super(message);
    this.name = 'AbortedError';
    this.partial = partial;
  }
}
