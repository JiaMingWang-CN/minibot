import {
  MISSING_IMAGE_TEXT,
  historyForModel,
  imagesOf,
  keepReasoning,
  textOf,
  type Adapter,
  type ModelRequest,
} from './adapter.ts';
import type { ResultAccumulator } from './accumulator.ts';
import { ModelError } from './types.ts';
import type { Block } from './types.ts';
import type { SseEvent } from './sse.ts';

interface ResponsesItem {
  id?: string;
  type?: string;
  name?: string;
  arguments?: string;
  [key: string]: unknown;
}

interface ResponsesPayload {
  type?: string;
  delta?: string;
  item_id?: string;
  item?: ResponsesItem;
  response?: {
    status?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number } | null;
    };
    error?: { message?: string; code?: string };
    incomplete_details?: { reason?: string };
  };
  [key: string]: unknown;
}

function responsesBody(req: ModelRequest): Record<string, unknown> {
  const input: Record<string, unknown>[] = [];
  for (const message of historyForModel(req.messages)) {
    if (message.role === 'user') {
      for (const block of message.blocks) {
        if (block.type === 'tool_result') {
          input.push({
            type: 'function_call_output',
            call_id: block.toolUseId,
            output: block.content,
          });
        }
      }
      const text = textOf(message.blocks);
      const content: Record<string, unknown>[] = [];
      if (text.length > 0) content.push({ type: 'input_text', text });
      for (const image of imagesOf(message.blocks)) {
        const data = req.attachments?.[image.id];
        content.push(
          data === undefined
            ? { type: 'input_text', text: MISSING_IMAGE_TEXT }
            : { type: 'input_image', image_url: `data:${image.mediaType};base64,${data}` },
        );
      }
      if (content.length > 0) input.push({ role: 'user', content });
    } else {
      for (const block of message.blocks) {
        if (block.type === 'reasoning') {
          if (keepReasoning(block, 'responses', req.model)) {
            input.push(block.opaque.data as Record<string, unknown>);
          }
        } else if (block.type === 'text') {
          input.push({ role: 'assistant', content: [{ type: 'output_text', text: block.text }] });
        } else if (block.type === 'tool_use') {
          input.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
        }
      }
    }
  }

  const body: Record<string, unknown> = {
    model: req.model,
    instructions: req.system,
    input,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
  };
  if (req.tools.length > 0) {
    body['tools'] = req.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
  if (req.thinkingLevel === 'off') {
    body['thinking'] = { type: 'disabled' };
  } else if (req.thinkingLevel !== null) {
    body['reasoning'] = { effort: req.thinkingLevel };
  }
  return body;
}

function failedMessage(payload: ResponsesPayload): string {
  const message = payload.response?.error?.message;
  return typeof message === 'string' && message.length > 0 ? message : '模型流式响应失败';
}

async function responsesParse(
  events: AsyncIterable<SseEvent>,
  acc: ResultAccumulator,
  model: string,
): Promise<void> {
  let hasToolCall = false;
  for await (const ev of events) {
    if (ev.data.length === 0 || ev.data === '[DONE]') continue;
    const payload = JSON.parse(ev.data) as ResponsesPayload;
    const type = payload.type ?? ev.event ?? '';
    if (type === 'response.output_text.delta') {
      if (typeof payload.delta === 'string') acc.text(payload.delta);
    } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      if (typeof payload.delta === 'string') acc.reasoning(payload.delta);
    } else if (type === 'response.output_item.added') {
      const item = payload.item;
      if (item?.type === 'function_call') {
        hasToolCall = true;
        if (typeof item.id === 'string' && typeof item.name === 'string') acc.toolStart(item.id, item.name);
        if (typeof item.arguments === 'string' && item.arguments.length > 0) {
          acc.toolArgs(item.id ?? '', item.arguments);
        }
        acc.stop('tool_use');
      }
    } else if (type === 'response.function_call_arguments.delta') {
      if (typeof payload.item_id === 'string' && typeof payload.delta === 'string') {
        acc.toolArgs(payload.item_id, payload.delta);
      }
    } else if (type === 'response.output_item.done') {
      const item = payload.item;
      if (item?.type === 'reasoning') {
        acc.reasoningOpaque({ format: 'responses', model, data: item });
      } else if (item?.type === 'function_call') {
        hasToolCall = true;
        if (typeof item.id === 'string' && typeof item.name === 'string') acc.toolStart(item.id, item.name);
        if (typeof item.arguments === 'string' && item.arguments.length > 0) {
          acc.toolArgs(item.id ?? '', item.arguments);
        }
        acc.stop('tool_use');
      }
    } else if (type === 'response.completed') {
      const usage = payload.response?.usage;
      if (usage !== undefined) {
        const cached = usage.input_tokens_details?.cached_tokens;
        acc.usage({
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          ...(typeof cached === 'number' ? { cachedInputTokens: cached } : {}),
        });
      }
      acc.stop(hasToolCall ? 'tool_use' : 'end');
    } else if (type === 'response.incomplete') {
      const reason = payload.response?.incomplete_details?.reason;
      acc.stop(reason === 'max_output_tokens' ? 'max_tokens' : hasToolCall ? 'tool_use' : 'end');
    } else if (type === 'response.failed') {
      throw new ModelError('stream', failedMessage(payload), { partial: acc.snapshot() });
    } else if (type === 'error') {
      throw new ModelError('stream', failedMessage(payload), { partial: acc.snapshot() });
    }
  }
}

export const responsesAdapter: Adapter = {
  format: 'responses',
  path: '/responses',
  headers: (apiKey) => ({
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }),
  body: responsesBody,
  parse: responsesParse,
};
