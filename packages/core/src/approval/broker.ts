import { randomUUID } from 'node:crypto';
import type { ToolName } from './policy.ts';

export interface ApprovalRequest {
  id: string;
  botId: string;
  threadId: string;
  tool: ToolName;
  summary: string;
  createdAt: number;
}

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

  request(r: Omit<ApprovalRequest, 'id' | 'createdAt'>, signal: AbortSignal): Promise<ApprovalResult> {
    if (signal.aborted) return Promise.resolve('cancelled');
    const request: ApprovalRequest = {
      ...r,
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

  pending(): ApprovalRequest[] {
    return [...this.pendingEntries.values()].map((e) => e.request);
  }
}
