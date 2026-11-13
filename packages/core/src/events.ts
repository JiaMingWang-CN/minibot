import type { ApprovalRequest } from './approval/broker.ts';
import type { Delta, StoredMessage } from './model/types.ts';
import type { McpStatus } from './mcp/manager.ts';

export type KernelEvent =
  | { type: 'delta'; threadId: string; delta: Delta }
  | { type: 'message'; threadId: string; message: StoredMessage }
  | { type: 'turn'; threadId: string; state: 'running' | 'idle' }
  | { type: 'approval_request'; request: ApprovalRequest }
  | { type: 'approval_resolved'; id: string; result: string }
  | { type: 'memory_changed'; path: string }
  /** 模型调用失败后自动重试：第 attempt 次重试将在 delayMs 后开始 */
  | { type: 'retry'; threadId: string; attempt: number; delayMs: number; message: string }
  /** 线程中 id >= fromId 的消息已删除（手动重试） */
  | { type: 'messages_deleted'; threadId: string; fromId: number }
  | { type: 'thread_deleted'; threadId: string }
  /** 手机功能的状态变化（只经本机 WS 推送，不会发给手机） */
  | { type: 'remote_changed' }
  /** MCP server 连接状态变化 */
  | { type: 'mcp_status'; serverId: string; status: McpStatus; error: string | null };
