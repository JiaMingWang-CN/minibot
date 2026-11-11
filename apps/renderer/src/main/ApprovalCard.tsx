// 审批卡片：浮在输入框上方，问完才继续这一轮。标出是哪个 bot、哪个对话发起的；
// 处理后变成已处理状态，停留片刻再消失。

import { useState } from 'react';
import type { ApprovalRequest } from '@minibot/core';
import { ShieldAlert } from 'lucide-react';
import { cn } from '../lib/cn';
import { t, type MessageKey } from '../i18n';
import { ELEVATED_FLOAT, PILL_PRIMARY, PILL_SECONDARY } from '../ui/recipes';

export type ApprovalResult = 'approved' | 'denied' | 'cancelled';

const RESULT: Record<ApprovalResult, { key: MessageKey; tone: string }> = {
  approved: { key: 'activity.result.approved', tone: 'text-success' },
  denied: { key: 'activity.result.denied', tone: 'text-danger' },
  cancelled: { key: 'activity.result.cancelled', tone: 'text-ink-tertiary' },
};

export function ApprovalCard({
  request,
  source,
  result,
  onRespond,
}: {
  request: ApprovalRequest;
  /** “bot 名 · 对话名” */
  source: string;
  result: ApprovalResult | undefined;
  onRespond: (approve: boolean, always: boolean) => void;
}) {
  const [always, setAlways] = useState(false);
  const done = result !== undefined;
  return (
    <div
      role="alertdialog"
      aria-label={t('approval.title')}
      className={cn('flex animate-pop-in flex-col gap-3 rounded-[18px] p-4 transition-opacity', ELEVATED_FLOAT, done && 'opacity-60')}>
      <div className="flex items-start gap-2.5">
        <ShieldAlert size={18} className={cn('mt-px shrink-0', done ? 'text-ink-tertiary' : 'text-warning')} aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-baseline gap-2">
            <span className="text-[14px] font-medium">{t('approval.title')}</span>
            <span className="min-w-0 truncate text-[12px] text-ink-tertiary">{source}</span>
          </span>
          <span className="text-[13px] break-words text-ink-secondary">{request.summary}</span>
        </div>
      </div>
      {request.command !== undefined && (
        <pre className="overflow-x-auto rounded-lg bg-inset px-3 py-2 font-mono text-[12px] whitespace-pre-wrap">{request.command}</pre>
      )}
      {done ? (
        <span role="status" className={cn('self-end text-[13px]', RESULT[result].tone)}>
          {t(RESULT[result].key)}
        </span>
      ) : (
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
      )}
    </div>
  );
}
