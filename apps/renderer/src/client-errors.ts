// 渲染端未捕获错误的入口：注册 window.onerror / unhandledrejection，
// 同一 message 每分钟最多上报一次；实际发送者由 App 在内核连上后注入。

import type { ClientErrorReport } from './api';

const THROTTLE_MS = 60_000;
const MAX_TRACKED = 100;

let sender: ((input: ClientErrorReport) => void) | null = null;
const lastSentAt = new Map<string, number>();

export function setClientErrorSender(fn: (input: ClientErrorReport) => void): void {
  sender = fn;
}

export function reportClientError(input: ClientErrorReport): void {
  const now = Date.now();
  const last = lastSentAt.get(input.message);
  if (last !== undefined && now - last < THROTTLE_MS) return;
  lastSentAt.set(input.message, now);
  if (lastSentAt.size > MAX_TRACKED) {
    for (const [message, at] of lastSentAt) {
      if (now - at >= THROTTLE_MS) lastSentAt.delete(message);
    }
  }
  try {
    sender?.(input);
  } catch {
    // 上报失败不影响应用
  }
}

function report(err: unknown, fallback: string): void {
  if (err instanceof Error) {
    reportClientError({
      message: err.message.length > 0 ? err.message : fallback,
      ...(typeof err.stack === 'string' ? { stack: err.stack } : {}),
    });
    return;
  }
  reportClientError({ message: typeof err === 'string' ? err : fallback });
}

export function installClientErrorHandler(): void {
  window.addEventListener('error', (event) => {
    report(event.error, event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    report(event.reason, 'unhandledrejection');
  });
}
