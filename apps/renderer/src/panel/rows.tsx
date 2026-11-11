// bot 侧板的行与卡片：照 OpenMausBot 的 bot-panel/rows，一行 46px 起，左图标、中标题说明、右值或控件。

import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Trash2, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';
import { Switch } from '../ui/settings';

export const rowCls = 'flex min-h-[46px] items-center gap-2.5 px-3.5 py-[11px]';
export const roundButtonCls =
  'flex size-[34px] shrink-0 items-center justify-center rounded-full bg-composer text-ink shadow-float ring-[0.5px] ring-ink/10 transition-colors hover:bg-[color-mix(in_srgb,var(--color-composer),var(--color-ink)_6%)]';
export const buttonCls =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[8px] bg-ink/[0.06] px-3.5 text-[13px] font-medium text-ink hover:bg-ink/10 disabled:opacity-50';
export const primaryButtonCls =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[8px] bg-ink px-3.5 text-[13px] font-medium text-on-ink hover:bg-ink/85 disabled:opacity-40';
export const panelInputCls =
  'w-full min-w-0 rounded-lg border-[0.5px] border-hairline bg-inset px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-ink/40 disabled:opacity-50';
const titleCls = 'text-[14px] font-medium text-ink';
const hintCls = 'mt-px text-[13px] leading-[1.35] text-ink-secondary';

export function CardLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-3.5 mt-5 mb-2 flex min-h-5 items-center justify-between gap-3 text-[13px] font-semibold text-ink-secondary">
      <span className="min-w-0 truncate">{children}</span>
      {action}
    </div>
  );
}

export function Card({ label, action, children }: { label?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      {label !== undefined ? <CardLabel action={action}>{label}</CardLabel> : <div className="h-3.5" />}
      <div className="divide-y divide-ink/[0.05] overflow-hidden rounded-[12px] bg-composer ring-1 ring-ink/[0.06] ring-inset">{children}</div>
    </section>
  );
}

export function RowText({ title, hint }: { title: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <div className={titleCls}>{title}</div>
      {hint !== undefined && <div className={hintCls}>{hint}</div>}
    </div>
  );
}

export function RowIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center text-ink-secondary" aria-hidden>
      <Icon size={16} />
    </span>
  );
}

export function NavRow({
  title,
  hint,
  value,
  icon,
  onClick,
  drill = true,
  disabled,
}: {
  title: ReactNode;
  hint?: ReactNode;
  value?: ReactNode;
  icon?: LucideIcon;
  onClick: () => void;
  drill?: boolean;
  disabled?: boolean;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={cn(rowCls, 'w-full text-left enabled:hover:bg-ink/[0.03] disabled:opacity-45')}>
      {icon !== undefined && <RowIcon icon={icon} />}
      <RowText title={title} hint={hint} />
      {value !== undefined && value !== null && value !== '' && (
        <span className="inline-flex max-w-[45%] shrink-0 items-center gap-1 truncate text-[13px] text-ink-secondary">{value}</span>
      )}
      {drill && <ChevronRight size={15} className="shrink-0 text-ink-tertiary" aria-hidden />}
    </button>
  );
}

export function SwitchRow({
  title,
  hint,
  icon,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  hint?: ReactNode;
  icon?: LucideIcon;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <div className={rowCls}>
      {icon !== undefined && <RowIcon icon={icon} />}
      <RowText title={title} hint={hint} />
      <Switch checked={checked} disabled={disabled} aria-label={title} onClick={onChange} />
    </div>
  );
}

export function ColRow({ children }: { children: ReactNode }) {
  return <div className={cn(rowCls, 'flex-col items-stretch gap-[9px]')}>{children}</div>;
}

export function NoteRow({ children, tone }: { children: ReactNode; tone?: 'warn' | 'ok' }) {
  return (
    <div className={rowCls}>
      <div className={cn('text-[13px] leading-[1.35]', tone === 'warn' ? 'text-danger' : tone === 'ok' ? 'text-success' : 'text-ink-secondary')}>{children}</div>
    </div>
  );
}

export function LinkRow({ children, onClick, icon: Icon = ChevronRight }: { children: ReactNode; onClick: () => void; icon?: LucideIcon }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-2 px-3.5 py-[11px] text-left text-[13px] text-ink-secondary hover:text-ink">
      <span className="min-w-0 flex-1">{children}</span>
      <Icon size={14} className="shrink-0" aria-hidden />
    </button>
  );
}

export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
  tooltip?: string;
}

export function Segmented<V extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
}: {
  options: readonly SegmentOption<V>[];
  value: V;
  onChange: (value: V) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className="flex w-full rounded-full bg-ink/[0.05] p-[3px]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          title={option.tooltip}
          onClick={() => onChange(option.value)}
          className={cn(
            'min-w-0 flex-auto truncate rounded-full px-1.5 py-1.5 text-[13px] whitespace-nowrap transition-colors disabled:opacity-50',
            value === option.value ? 'bg-ink/[0.14] text-ink' : 'text-ink-secondary enabled:hover:text-ink',
          )}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function TrashButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-tertiary hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50">
      <Trash2 size={14} aria-hidden />
    </button>
  );
}

export function PageHeader({ back, title, intro, onBack }: { back: string; title: string; intro?: ReactNode; onBack: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mt-0.5 inline-flex items-center gap-0.5 rounded-[8px] py-1 pr-2 pl-0.5 text-[13px] text-ink-secondary hover:bg-ink/[0.04] hover:text-ink">
        <ChevronLeft size={15} aria-hidden />
        <span>{back}</span>
      </button>
      <h3 className="mx-1 mt-1.5 text-[18px] font-semibold break-all text-ink">{title}</h3>
      {intro !== undefined && <p className="mx-1 mt-1.5 text-[13px] leading-normal text-ink-secondary">{intro}</p>}
    </div>
  );
}
