// 锚定在触发元素上的浮层：渲染到 body（不被滚动容器裁掉），用 fixed 定位，
// 下方放不下时翻到上方。点外面或按 Esc 关闭。

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

const GAP = 6;
const MARGIN = 8;

export function Popover({
  anchor,
  open,
  onClose,
  align = 'start',
  width,
  children,
  className,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  align?: 'start' | 'end';
  width?: number;
  children: ReactNode;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });

  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const a = anchor.current?.getBoundingClientRect();
      const p = panel.current;
      if (a === undefined || p === null) return;
      const w = p.offsetWidth;
      const h = p.offsetHeight;
      const left = Math.max(
        MARGIN,
        Math.min(align === 'end' ? a.right - w : a.left, window.innerWidth - w - MARGIN),
      );
      const below = a.bottom + GAP;
      const top = below + h > window.innerHeight - MARGIN && a.top - GAP - h > MARGIN ? a.top - GAP - h : below;
      setStyle({ left, top, maxHeight: window.innerHeight - top - MARGIN });
    };
    place();
    const away = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) onClose();
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        anchor.current?.focus();
      }
    };
    window.addEventListener('resize', place);
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open, anchor, align, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panel}
      className={`fixed z-50 overflow-y-auto ${className ?? ''}`}
      style={{ ...style, ...(width !== undefined ? { width } : {}) }}>
      {children}
    </div>,
    document.body,
  );
}
