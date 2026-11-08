import { historyForModel, keepReasoning, textOf, type Adapter, type ModelRequest } from './adapter.ts';
import type { ResultAccumulator } from './accumulator.ts';
import type { Block } from './types.ts';
import type { SseEvent } from './sse.ts';

interface ChatToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatChoice {
  delta?: {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: ChatToolCallDelta[];
  };
  finish_reason?: string | null;
}

interface ChatChunk {
  choices?: ChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

function stopReasonOf(finish: string): 'end' | 'tool_use' | 'max_tokens' {
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'length') return 'max_tokens';
  return 'end';
}

function chatBody(req: ModelRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [{ role: 'system', content: req.system }];
  for (const message of historyForModel(req.messages)) {
    if (message.role === 'user') {
      for (const block of message.blocks) {
        if (block.type === 'tool_result') {
          messages.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content });
        }
      }
      const text = textOf(message.blocks);
      if (text.length > 0) messages.push({ role: 'user', content: text });
    } else {
      const text = textOf(message.blocks);
      const toolCalls = message.blocks
        .filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
      const reasoningContent = message.blocks
        .filter((b) => keepReasoning(b, 'chat_completions', req.model) && b.type === 'reasoning')
        .map((b) => {
          const data = (b as Extract<Block, { type: 'reasoning' }>).opaque?.data;
          return data !== null && typeof data === 'object' && 'reasoning_content' in data
            ? String((data as { reasoning_content: unknown }).reasoning_content ?? '')
            : '';
        })
        .join('');
      if (text.length === 0 && toolCalls.length === 0 && reasoningContent.length === 0) continue;
      const assistant: Record<string, unknown> = { role: 'assistant', content: text };
      if (toolCalls.length > 0) assistant['tool_calls'] = toolCalls;
      if (reasoningContent.length > 0) assistant['reasoning_content'] = reasoningContent;
      messages.push(assistant);
    }
  }

  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools.length > 0) {
    body['tools'] = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (req.thinkingLevel === 'off') {
    body['thinking'] = { type: 'disabled' };
  } else if (req.thinkingLevel !== null) {
    body['reasoning_effort'] = req.thinkingLevel;
  }
  return body;
}

async function chatParse(
  events: AsyncIterable<SseEvent>,
  acc: ResultAccumulator,
): Promise<void> {
  for await (const ev of events) {
    if (ev.data === '[DONE]') return;
    if (ev.data.length === 0) continue;
    const chunk = JSON.parse(ev.data) as ChatChunk;
    if (chunk.usage !== undefined && chunk.usage !== null) {
      acc.usage({
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      });
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (delta !== undefined) {
        if (typeof delta.reasoning_content === 'string') acc.reasoning(delta.reasoning_content);
        if (typeof delta.content === 'string') acc.text(delta.content);
        for (const call of delta.tool_calls ?? []) {
          const key = String(call.index ?? 0);
          if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
            acc.toolStart(key, call.function.name);
          }
          if (typeof call.function?.arguments === 'string' && call.function.arguments.length > 0) {
            acc.toolArgs(key, call.function.arguments);
          }
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
        acc.stop(stopReasonOf(choice.finish_reason));
      }
    }
  }
}

export const chatCompletionsAdapter: Adapter = {
  format: 'chat_completions',
  path: '/chat/completions',
  headers: (apiKey) => ({
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }),
  body: chatBody,
  parse: chatParse,
};
