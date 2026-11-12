import { randomUUID } from 'node:crypto';
import type { ToolName } from './policy.ts';

export interface ApprovalRequest {
  id: string;
  botId: string;
  threadId: string;
  tool: ToolName;
  summary: string;
  createdAt: number;
  /** run_command 的命令原文 */
  command?: string;
  /** write_file / edit_file 的内容预览（已截断、已脱敏）；不写进决策日志 */
  preview?: string;
  /** 是否可以勾选“总是允许此命令”（只有简单命令可以） */
  canAlwaysAllow: boolean;
}

export type ApprovalRequestInput = Omit<ApprovalRequest, 'id' | 'createdAt' | 'canAlwaysAllow'> & {
  canAlwaysAllow?: boolean;
};

export type ApprovalEvent =
  | { type: 'approval_request'; request: ApprovalRequest }
  | {
      type: 'approval_resolved';
      id: string;
      result: 'approved' | 'denied' | 'cancelled';
    };

type ApprovalResult = 'approved' | 'denied' | 'cancelled';

interface PendingEntry {
  request: ApprovalRequest;
  cleanup: () => void;
  resolve: (result: ApprovalResult) => void;
}

export class ApprovalBroker {
  private emit: (e: ApprovalEvent) => void;
  private pendingEntries = new Map<string, PendingEntry>();

  constructor(emit: (e: ApprovalEvent) => void) {
    this.emit = emit;
  }

  request(r: ApprovalRequestInput, signal: AbortSignal): Promise<ApprovalResult> {
    if (signal.aborted) return Promise.resolve('cancelled');
    const request: ApprovalRequest = {
      ...r,
      canAlwaysAllow: r.canAlwaysAllow ?? false,
      id: randomUUID(),
      createdAt: Date.now(),
    };
    return new Promise<ApprovalResult>((resolve) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        this.pendingEntries.delete(request.id);
        this.emit({ type: 'approval_resolved', id: request.id, result: 'cancelled' });
        resolve('cancelled');
      };
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingEntries.set(request.id, { request, cleanup, resolve });
      this.emit({ type: 'approval_request', request });
    });
  }

  respond(id: string, approve: boolean): boolean {
    const entry = this.pendingEntries.get(id);
    if (entry === undefined) return false;
    this.pendingEntries.delete(id);
    entry.cleanup();
    const result: ApprovalResult = approve ? 'approved' : 'denied';
    this.emit({ type: 'approval_resolved', id, result });
    entry.resolve(result);
    return true;
  }

  get(id: string): ApprovalRequest | undefined {
    return this.pendingEntries.get(id)?.request;
  }

  pending(): ApprovalRequest[] {
    return [...this.pendingEntries.values()].map((e) => e.request);
  }
}
