// 下拉菜单：触发按钮由调用方渲染（拿到 ref 与开关属性），菜单内容是分组的行。

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../lib/cn';
import { Popover } from './Popover';
import { MENU_LABEL, MENU_ROW, MENU_SEPARATOR, MENU_SHEET } from './recipes';

export type MenuItem =
  | {
      label: string;
      onSelect: () => void;
      icon?: ReactNode;
      checked?: boolean;
      danger?: boolean;
      disabled?: boolean;
      hint?: string;
    }
  | { type: 'label'; label: string }
  | { type: 'separator' };

export interface MenuTriggerProps {
  ref: React.RefObject<HTMLButtonElement | null>;
  onClick: () => void;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
}

export function Menu({
  items,
  trigger,
  align = 'start',
  width = 220,
}: {
  items: MenuItem[];
  trigger: (props: MenuTriggerProps) => ReactNode;
  align?: 'start' | 'end';
  width?: number;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      {trigger({ ref, onClick: () => setOpen((o) => !o), 'aria-haspopup': 'menu', 'aria-expanded': open })}
      <Popover anchor={ref} open={open} onClose={close} align={align} width={width}>
        <div role="menu" className={MENU_SHEET}>
          {items.map((item, i) => {
            if ('type' in item) {
              return item.type === 'label' ? (
                <div key={i} className={MENU_LABEL}>
                  {item.label}
                </div>
              ) : (
                <div key={i} role="separator" className={MENU_SEPARATOR} />
              );
            }
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={cn(MENU_ROW, item.danger === true && 'text-danger')}
                onClick={() => {
                  close();
                  item.onSelect();
                }}>
                {item.icon !== undefined && <span className="flex size-4 shrink-0 items-center justify-center text-ink-secondary">{item.icon}</span>}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint !== undefined && <span className="shrink-0 text-[12px] text-ink-tertiary">{item.hint}</span>}
                {item.checked === true && <Check size={14} className="shrink-0" aria-hidden />}
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}
