// 设置界面的公共零件：分组标题 + 白底细线卡片 + 一行一项（左标题说明、右控件），以及开关、按钮、输入框。
// 应用设置弹窗与 bot 侧板共用。

import { useId, type ComponentProps, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../lib/cn';
import { FIELD } from './recipes';

/** 白底细线卡片 */
export const SETTINGS_CARD = 'rounded-[12px] border-[0.5px] border-edge bg-menu';

/** 设置里的小号按钮：次按钮是淡墨底，主按钮是墨色填充 */
export const BUTTON =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full bg-ink/5 px-3 text-[14px] text-ink transition-colors enabled:hover:bg-ink/10 disabled:opacity-40';
export const BUTTON_PRIMARY =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full bg-ink px-3 text-[14px] text-on-ink transition-colors enabled:hover:bg-ink/85 disabled:opacity-40';
export const BUTTON_DANGER =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full bg-danger/10 px-3 text-[14px] text-danger transition-colors enabled:hover:bg-danger/15 disabled:opacity-40';

export function Switch({ checked, className, ...props }: Omit<ComponentProps<'button'>, 'children' | 'role' | 'aria-checked'> & { checked: boolean }) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn(
        'relative h-5 w-8 shrink-0 rounded-full transition-colors disabled:opacity-40',
        checked ? 'bg-ink' : 'bg-ink/[0.12] ring-1 ring-ink/45 ring-inset',
        className,
      )}>
      <span className={cn('absolute top-0.5 size-4 rounded-full transition-[left]', checked ? 'left-[14px] bg-app' : 'left-0.5 bg-white')} />
    </button>
  );
}

export function SettingsGroup({ label, actions, footnote, children }: { label?: string; actions?: ReactNode; footnote?: ReactNode; children: ReactNode }) {
  const labelId = useId();
  return (
    <section aria-labelledby={label !== undefined ? labelId : undefined} className="flex flex-col gap-2">
      {(label !== undefined || actions !== undefined) && (
        <div className="flex min-h-4 items-center justify-between gap-3 pr-1 pl-4">
          {label !== undefined && (
            <h3 id={labelId} className="text-[13px] leading-4 font-semibold text-ink-secondary">
              {label}
            </h3>
          )}
          {actions}
        </div>
      )}
      {children}
      {footnote !== undefined && <p className="-mt-0.5 pl-4 text-[12px] leading-4 text-ink-tertiary">{footnote}</p>}
    </section>
  );
}

export function SettingsRows({ children }: { children: ReactNode }) {
  return <div className={cn(SETTINGS_CARD, 'flex flex-col py-2')}>{children}</div>;
}

export function SettingRow({ title, subtitle, children, message }: { title: string; subtitle?: ReactNode; children?: ReactNode; message?: ReactNode }) {
  const titleId = useId();
  return (
    <div role="group" aria-labelledby={titleId} className="px-4 py-2.5">
      <div className="flex min-h-6 flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex min-w-[min(100%,15rem)] flex-1 flex-col gap-0.5">
          <div id={titleId} className="text-[14px] leading-5 text-ink">
            {title}
          </div>
          {subtitle !== undefined && <div className="text-[13px] leading-[18px] text-pretty text-ink-secondary">{subtitle}</div>}
        </div>
        {children !== undefined && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
      </div>
      {message !== undefined && <div className="mt-2 text-[12px]">{message}</div>}
    </div>
  );
}

/** 标签在上、输入框在下的一项 */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] text-ink-secondary">{label}</span>
      {children}
      {hint !== undefined && <span className="text-[12px] leading-4 text-ink-tertiary">{hint}</span>}
    </label>
  );
}

export function SelectField({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <span className={cn('relative flex', className)}>
      <select aria-label={label} className={cn(FIELD, 'appearance-none py-1.5 pr-9 text-[13px]')} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-tertiary" aria-hidden />
    </span>
  );
}

/** 设置里的输入框：比表单默认的矮一号 */
export const INPUT = cn(FIELD, 'py-1.5 text-[13px]');

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
