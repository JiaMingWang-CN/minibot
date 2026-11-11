// 审批卡片：浮在输入框上方，问完才继续这一轮。

import { useState } from 'react';
import type { ApprovalRequest } from '@minibot/core';
import { ShieldAlert } from 'lucide-react';
import { t } from '../i18n';
import { ELEVATED_FLOAT, PILL_PRIMARY, PILL_SECONDARY } from '../ui/recipes';

export function ApprovalCard({
  request,
  onRespond,
}: {
  request: ApprovalRequest;
  onRespond: (approve: boolean, always: boolean) => void;
}) {
  const [always, setAlways] = useState(false);
  return (
    <div role="alertdialog" aria-label={t('approval.title')} className={`flex animate-pop-in flex-col gap-3 rounded-[18px] p-4 ${ELEVATED_FLOAT}`}>
      <div className="flex items-start gap-2.5">
        <ShieldAlert size={18} className="mt-px shrink-0 text-warning" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[14px] font-medium">{t('approval.title')}</span>
          <span className="text-[13px] break-words text-ink-secondary">{request.summary}</span>
        </div>
      </div>
      {request.command !== undefined && (
        <pre className="overflow-x-auto rounded-lg bg-inset px-3 py-2 font-mono text-[12px] whitespace-pre-wrap">{request.command}</pre>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {request.canAlwaysAllow && (
          <label className="mr-auto flex items-center gap-2 text-[13px] text-ink-secondary">
            <input type="checkbox" className="size-4 accent-[var(--color-ink)]" checked={always} onChange={(e) => setAlways(e.target.checked)} />
            {t('approval.always')}
          </label>
        )}
        <span className="ml-auto flex gap-2">
          <button type="button" className={`${PILL_SECONDARY} h-8`} onClick={() => onRespond(false, false)}>
            {t('approval.deny')}
          </button>
          <button type="button" className={`${PILL_PRIMARY} h-8`} onClick={() => onRespond(true, always)}>
            {t('approval.approve')}
          </button>
        </span>
      </div>
    </div>
  );
}
