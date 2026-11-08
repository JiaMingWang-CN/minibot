import type { ApprovalRequest } from './approval/broker.ts';
import type { Delta, StoredMessage } from './model/types.ts';

export type KernelEvent =
  | { type: 'delta'; threadId: string; delta: Delta }
  | { type: 'message'; threadId: string; message: StoredMessage }
  | { type: 'turn'; threadId: string; state: 'running' | 'idle' }
  | { type: 'approval_request'; request: ApprovalRequest }
  | { type: 'approval_resolved'; id: string; result: string }
  | { type: 'memory_changed'; path: string };
