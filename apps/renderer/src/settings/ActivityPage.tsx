// 审批记录：每次需要批准的操作、结果与谁做的决定，新的在上，一次加载 50 条。

import { useCallback, useEffect, useState } from 'react';
import type { ApprovalLogEntry } from '@minibot/core';
import type { Api } from '../api';
import { cn } from '../lib/cn';
import { t, type MessageKey } from '../i18n';
import { BUTTON, SETTINGS_CARD, errorText, formatTime } from '../ui/settings';

const PAGE = 50;

const RESULT: Record<NonNullable<ApprovalLogEntry['result']> | 'pending', { key: MessageKey; tone: string }> = {
  approved: { key: 'activity.result.approved', tone: 'text-success' },
  denied: { key: 'activity.result.denied', tone: 'text-danger' },
  cancelled: { key: 'activity.result.cancelled', tone: 'text-ink-tertiary' },
  pending: { key: 'activity.result.pending', tone: 'text-warning' },
};

export function ActivityPage({ api }: { api: Api }) {
  const [rows, setRows] = useState<ApprovalLogEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before?: number): Promise<void> => {
      try {
        const page = await api.approvalLog(before, PAGE);
        setRows((list) => (before === undefined ? page : [...(list ?? []), ...page]));
        setMore(page.length === PAGE);
      } catch (err) {
        setError(errorText(err));
      }
    },
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== null) return <p className="text-[13px] text-danger">{error}</p>;
  if (rows === null) return <p className="text-[13px] text-ink-secondary">{t('common.loading')}</p>;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] leading-[18px] text-ink-secondary">{t('activity.intro')}</p>
      {rows.length === 0 ? (
        <p className={cn(SETTINGS_CARD, 'px-4 py-6 text-center text-[13px] text-ink-secondary')}>{t('activity.empty')}</p>
      ) : (
        <ul className={cn(SETTINGS_CARD, 'flex flex-col divide-y-[0.5px] divide-edge')}>
          {rows.map((row) => {
            const result = RESULT[row.result ?? 'pending'];
            return (
              <li key={row.id} className="flex flex-col gap-1 px-4 py-3">
                <div className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 text-[14px] leading-5 text-ink">{row.summary}</span>
                  <span className={cn('shrink-0 text-[12px]', result.tone)}>{t(result.key)}</span>
                </div>
                {row.command !== null && (
                  <code className="block rounded-md bg-inset px-2 py-1 font-mono text-[12px] break-all whitespace-pre-wrap text-ink">{row.command}</code>
                )}
                <div className="text-[12px] text-ink-tertiary">
                  {formatTime(row.createdAt)}
                  {row.decidedBy !== null && ` · ${t(`activity.by.${row.decidedBy}` as MessageKey)}`}
                  {row.always && ` · ${t('activity.always')}`}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {more && (
        <button type="button" className={cn(BUTTON, 'self-center')} onClick={() => void load(rows.at(-1)?.id)}>
          {t('activity.more')}
        </button>
      )}
    </div>
  );
}
