// 输入框里的审批方式切换：图标按钮，弹出三档（逐项批准 / 自动接受编辑 / 全部放行），每档带一句说明，
// 最后一项打开命令白名单。
// 改的是 bot 的设置，直接生效，不弹确认。

import { useCallback, useRef, useState } from 'react';
import type { ApprovalMode } from '@minibot/core';
import { Check, FilePen, Hand, ListChecks, ShieldAlert } from 'lucide-react';
import { cn } from '../lib/cn';
import { t, type MessageKey } from '../i18n';
import { Popover } from '../ui/Popover';
import { ICON_BUTTON_SM, MENU_SEPARATOR, MENU_SHEET } from '../ui/recipes';

const OPTIONS: { mode: ApprovalMode; Icon: typeof Hand }[] = [
  { mode: 'ask', Icon: Hand },
  { mode: 'edits', Icon: FilePen },
  { mode: 'auto', Icon: ShieldAlert },
];

const label = (mode: ApprovalMode): string => t(`approvalMode.${mode}.label` as MessageKey);

export function ApprovalModePicker({
  mode,
  disabled,
  onChange,
  onManageAllowlist,
}: {
  mode: ApprovalMode;
  disabled: boolean;
  onChange: (mode: ApprovalMode) => void;
  onManageAllowlist: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const Current = (OPTIONS.find((o) => o.mode === mode) ?? OPTIONS[0]!).Icon;

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('approvalMode.trigger', { mode: label(mode) })}
        title={label(mode)}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(ICON_BUTTON_SM, mode === 'auto' && 'text-warning hover:text-warning aria-expanded:text-warning')}>
        <Current size={15} aria-hidden />
      </button>
      <Popover anchor={ref} open={open} onClose={close} width={300}>
        <div role="menu" aria-label={t('approvalMode.question')} className={MENU_SHEET}>
          <div className="px-2 pt-1 pb-0.5 text-[13px] font-medium text-ink">{t('approvalMode.question')}</div>
          <div role="separator" className={MENU_SEPARATOR} />
          {OPTIONS.map(({ mode: option, Icon }) => {
            const selected = option === mode;
            return (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  close();
                  if (!selected) onChange(option);
                }}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-ink/[0.06] focus-visible:bg-ink/[0.06] focus-visible:outline-none">
                <Icon size={15} className="mt-0.5 shrink-0 text-ink-secondary" aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center justify-between gap-3 text-[13px] text-ink">
                    {label(option)}
                    {selected && <Check size={14} className="shrink-0" aria-hidden />}
                  </span>
                  <span className="text-[12px] leading-snug text-ink-secondary">{t(`approvalMode.${option}.desc` as MessageKey)}</span>
                </span>
              </button>
            );
          })}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              ref.current?.focus();
              onManageAllowlist();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink hover:bg-ink/[0.06] focus-visible:bg-ink/[0.06] focus-visible:outline-none">
            <ListChecks size={15} className="shrink-0 text-ink-secondary" aria-hidden />
            {t('allowlist.title')}
          </button>
        </div>
      </Popover>
    </>
  );
}
