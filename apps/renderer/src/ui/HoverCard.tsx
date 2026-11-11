// 悬停（或键盘聚焦）时在触发元素下方显示的说明卡片。

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Popover } from './Popover';
import { MENU_SHEET } from './recipes';

export function HoverCard({ content, children, label }: { content: ReactNode; children: ReactNode; label: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = (): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), 200);
  };
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setOpen(false);
  }, []);
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2 text-ink-secondary hover:bg-ink/[0.06]"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}>
        {children}
      </button>
      <Popover anchor={ref} open={open} onClose={hide} align="end">
        <div role="tooltip" className={`${MENU_SHEET} px-3 py-2.5`}>
          {content}
        </div>
      </Popover>
    </>
  );
}
