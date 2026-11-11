import type { StoredMessage } from '../model/types.ts';

const MAX_TOOL_CHARS = 2000;

function clip(text: string): string {
  return text.length > MAX_TOOL_CHARS ? `${text.slice(0, MAX_TOOL_CHARS)}…[已截断]` : text;
}

// 把历史消息拼成纯文本对话记录，供摘要与后台整理使用：
// 不发送原始的工具块，避免孤立的 tool_result、以 assistant 结尾被当作续写等协议问题。
export function transcriptOf(messages: StoredMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.kind === 'notice') continue;
    for (const block of message.blocks) {
      if (block.type === 'text') {
        const who = message.kind === 'summary' ? '之前的摘要' : message.role === 'user' ? '用户' : '助手';
        lines.push(`【${who}】${block.text}`);
      } else if (block.type === 'tool_use') {
        lines.push(`【调用工具 ${block.name}】${clip(JSON.stringify(block.input))}`);
      } else if (block.type === 'tool_result') {
        lines.push(`【工具结果 ${block.status}】${clip(block.content)}`);
      } else if (block.type === 'image') {
        lines.push('【图片】');
      }
    }
  }
  return lines.join('\n');
}

// 包装成一条 user 消息，作为摘要 / 整理请求的唯一消息。
export function transcriptMessage(threadId: string, instruction: string, messages: StoredMessage[]): StoredMessage {
  return {
    id: 0,
    threadId,
    role: 'user',
    blocks: [{ type: 'text', text: `${instruction}\n\n<对话记录>\n${transcriptOf(messages)}\n</对话记录>` }],
    kind: null,
    interrupted: false,
    createdAt: Date.now(),
  };
}
