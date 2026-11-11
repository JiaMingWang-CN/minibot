// 模态对话框：半透明遮罩 + 居中卡片，Esc 或点遮罩关闭。

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ELEVATED_FLOAT } from './recipes';

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ReactNode;
  footer: ReactNode;
  /** 内容较多的对话框用更宽的卡片 */
  wide?: boolean;
}) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    // 先聚焦卡片里的第一个输入框，没有就聚焦卡片本身
    (card.current?.querySelector<HTMLElement>('input, textarea') ?? card.current)?.focus();
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/30 p-4"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`flex w-full ${wide ? 'max-w-[520px]' : 'max-w-[400px]'} animate-pop-in flex-col gap-4 rounded-2xl p-5 outline-none ${ELEVATED_FLOAT}`}>
        <h2 className="text-[16px] font-semibold">{title}</h2>
        {children}
        <div className="flex justify-end gap-2">{footer}</div>
      </div>
    </div>,
    document.body,
  );
}
