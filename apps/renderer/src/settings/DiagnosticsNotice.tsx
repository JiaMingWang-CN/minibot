// 诊断说明：完整清单（初始化与关于页共用）和主界面的一次性提示条。

import { X } from 'lucide-react';
import { t } from '../i18n';
import { PILL_PRIMARY, PILL_SECONDARY } from '../ui/recipes';

/** 会发送 / 不会发送的完整清单 */
export function DiagnosticsDetails() {
  return (
    <div className="flex flex-col gap-1.5 text-[12px] leading-[18px] text-ink-secondary">
      <p>{t('diagnostics.allowed')}</p>
      <p>{t('diagnostics.forbidden')}</p>
    </div>
  );
}

/** 同意状态还是 unset 时在主界面显示一次；关闭不改状态，下次启动再出现 */
export function DiagnosticsNotice({
  onDecide,
  onDismiss,
}: {
  onDecide: (consent: 'on' | 'off') => void;
  onDismiss: () => void;
}) {
  return (
    <div role="status" className="animate-pop-in rounded-xl bg-inset px-3.5 py-3 ring-[0.5px] ring-ink/10">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink">{t('diagnostics.prompt.title')}</p>
          <p className="mt-0.5 text-[12px] leading-[18px] text-ink-secondary">{t('diagnostics.prompt.body')}</p>
        </div>
        <button
          type="button"
          aria-label={t('diagnostics.prompt.dismiss')}
          onClick={onDismiss}
          className="shrink-0 rounded-full p-1 text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink">
          <X size={14} aria-hidden />
        </button>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <button type="button" className={`${PILL_PRIMARY} h-8 px-3.5 text-[13px]`} onClick={() => onDecide('on')}>
          {t('diagnostics.prompt.accept')}
        </button>
        <button type="button" className={`${PILL_SECONDARY} h-8 px-3.5 text-[13px]`} onClick={() => onDecide('off')}>
          {t('diagnostics.prompt.decline')}
        </button>
      </div>
    </div>
  );
}
