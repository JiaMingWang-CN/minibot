import { MISSING_IMAGE_TEXT, historyForModel, keepReasoning, type Adapter, type ModelRequest } from './adapter.ts';
import type { ResultAccumulator } from './accumulator.ts';
import { ModelError } from './types.ts';
import type { SseEvent } from './sse.ts';

interface AnthropicContentBlock {
  type?: string;
  id?: string;
  name?: string;
  data?: unknown;
  [key: string]: unknown;
}

interface AnthropicPayload {
  type?: string;
  index?: number;
  content_block?: AnthropicContentBlock;
  delta?: {
    type?: string;
    thinking?: string;
    signature?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  message?: { usage?: AnthropicUsage };
  usage?: AnthropicUsage;
  error?: { message?: string; type?: string };
  [key: string]: unknown;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function anthropicBody(req: ModelRequest): Record<string, unknown> {
  const messages: { role: 'user' | 'assistant'; content: Record<string, unknown>[] }[] = [];

  const push = (role: 'user' | 'assistant', content: Record<string, unknown>[]): void => {
    if (content.length === 0) return;
    const last = messages[messages.length - 1];
    if (last?.role === role) last.content.push(...content);
    else messages.push({ role, content });
  };

  for (const message of historyForModel(req.messages)) {
    const content: Record<string, unknown>[] = [];
    if (message.role === 'user') {
      for (const block of message.blocks) {
        if (block.type === 'tool_result') {
          content.push({
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            content: block.content,
            is_error: block.status !== 'ok',
          });
        }
      }
      for (const block of message.blocks) {
        if (block.type === 'text' && block.text.length > 0) {
          content.push({ type: 'text', text: block.text });
        } else if (block.type === 'skill') {
          content.push({ type: 'text', text: `已加载 skill：${block.name}\n\n${block.text}` });
        } else if (block.type === 'image') {
          const data = req.attachments?.[block.id];
          content.push(
            data === undefined
              ? { type: 'text', text: MISSING_IMAGE_TEXT }
              : { type: 'image', source: { type: 'base64', media_type: block.mediaType, data } },
          );
        }
      }
      push('user', content);
    } else {
      for (const block of message.blocks) {
        if (block.type === 'reasoning') {
          if (!keepReasoning(block, 'anthropic_messages', req.model)) continue;
          const data: unknown = block.opaque.data;
          if (isRecord(data) && typeof data['signature'] === 'string') {
            content.push({ type: 'thinking', thinking: block.text, signature: data['signature'] });
          } else if (isRecord(data) && 'redacted' in data) {
            content.push({ type: 'redacted_thinking', data: data['redacted'] });
          }
        } else if (block.type === 'text') {
          if (block.text.length > 0) content.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        }
      }
      push('assistant', content);
    }
  }

  // 提示缓存：断点放在系统提示（覆盖在它之前的工具定义）和最后一条消息的最后一个块上，
  // 工具调用的每一轮都能命中上一轮写入的前缀
  const cacheControl = { type: 'ephemeral' };
  // thinking 块不能直接带 cache_control，往前找最近一个可以带的块
  const lastContent = messages[messages.length - 1]?.content ?? [];
  const lastBlock = lastContent.findLast((b) => b['type'] !== 'thinking' && b['type'] !== 'redacted_thinking');
  if (lastBlock !== undefined) lastBlock['cache_control'] = cacheControl;

  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: [{ type: 'text', text: req.system, cache_control: cacheControl }],
    messages,
    stream: true,
  };
  if (req.tools.length > 0) {
    body['tools'] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  if (req.thinkingLevel === 'off') {
    body['thinking'] = { type: 'disabled' };
  } else if (req.thinkingLevel !== null) {
    body['output_config'] = { effort: req.thinkingLevel };
  }
  return body;
}

function stopReasonOf(reason: string | null | undefined): 'end' | 'tool_use' | 'max_tokens' {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  return 'end';
}

// Anthropic 的 input_tokens 不含缓存部分：总输入 = input + cache_read + cache_creation
function setUsage(acc: ResultAccumulator, usage: AnthropicUsage | undefined): void {
  if (usage === undefined) return;
  const u: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } = {};
  if (typeof usage.input_tokens === 'number') {
    const read = usage.cache_read_input_tokens ?? 0;
    const creation = usage.cache_creation_input_tokens ?? 0;
    u.inputTokens = usage.input_tokens + read + creation;
    if (typeof usage.cache_read_input_tokens === 'number') u.cachedInputTokens = usage.cache_read_input_tokens;
  }
  if (typeof usage.output_tokens === 'number') u.outputTokens = usage.output_tokens;
  acc.usage(u);
}

async function anthropicParse(
  events: AsyncIterable<SseEvent>,
  acc: ResultAccumulator,
  model: string,
): Promise<void> {
  let finished = false;
  for await (const ev of events) {
    if (ev.data.length === 0 || ev.data === '[DONE]') continue;
    const payload = JSON.parse(ev.data) as AnthropicPayload;
    const type = payload.type ?? ev.event ?? '';
    if (type === 'message_stop') finished = true;
    if (type === 'message_start') {
      setUsage(acc, payload.message?.usage);
    } else if (type === 'content_block_start') {
      const block = payload.content_block;
      if (block?.type === 'tool_use') {
        acc.toolStart(String(payload.index ?? 0), block.name ?? '');
      } else if (block?.type === 'redacted_thinking') {
        acc.reasoningOpaque({
          format: 'anthropic_messages',
          model,
          data: { redacted: block.data },
        });
      }
    } else if (type === 'content_block_delta') {
      const delta = payload.delta;
      if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        acc.reasoning(delta.thinking);
      } else if (delta?.type === 'signature_delta' && typeof delta.signature === 'string') {
        acc.reasoningOpaque({
          format: 'anthropic_messages',
          model,
          data: { signature: delta.signature },
        });
      } else if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        acc.text(delta.text);
      } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        acc.toolArgs(String(payload.index ?? 0), delta.partial_json);
      }
    } else if (type === 'message_delta') {
      setUsage(acc, payload.usage);
      acc.stop(stopReasonOf(payload.delta?.stop_reason));
      finished = true;
    } else if (type === 'error') {
      const message = payload.error?.message ?? '模型流式响应失败';
      throw new ModelError('stream', message, { partial: acc.snapshot() });
    }
  }
  // 连接断开而没有收到结束事件：半截回复不能当作完整回复
  if (!finished) throw new ModelError('stream', '响应中途中断', { partial: acc.snapshot() });
}

export const anthropicAdapter: Adapter = {
  format: 'anthropic_messages',
  path: '/v1/messages',
  headers: (apiKey) => ({
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  }),
  body: anthropicBody,
  parse: anthropicParse,
};
