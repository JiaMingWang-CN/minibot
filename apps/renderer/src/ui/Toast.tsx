// 椭圆通知：浮在窗口顶部居中，到时间自动关闭。key 变化（例如再次触发）会重新计时。

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';
import { ELEVATED_FLOAT } from './recipes';

export const TOAST_MS = 4000;

export function Toast({ toast, onClose }: { toast: { key: number; text: string } | null; onClose: () => void }) {
  const key = toast?.key;
  useEffect(() => {
    if (key === undefined) return;
    const timer = window.setTimeout(onClose, TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [key, onClose]);
  if (toast === null) return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-5 z-[60] flex justify-center px-4">
      <div role="status" className={cn(ELEVATED_FLOAT, 'flex max-w-full animate-fade-in items-center gap-2 rounded-full px-4 py-2 text-[13px] text-ink')}>
        <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden />
        <span className="min-w-0 truncate">{toast.text}</span>
      </div>
    </div>,
    document.body,
  );
}
