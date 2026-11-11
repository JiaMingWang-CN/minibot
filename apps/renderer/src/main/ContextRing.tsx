// 聊天头右侧的上下文占用圆环：常驻显示，悬停看明细——上下文占用条，以及本对话累计的输入、缓存命中、输出与调用次数。
// 平时是墨色，80% 起变警告色，95% 起变错误色。

import type { ThreadUsage } from '@minibot/core';
import { cn } from '../lib/cn';
import { t } from '../i18n';
import { HoverCard } from '../ui/HoverCard';
import { MENU_SEPARATOR } from '../ui/recipes';

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function Row({ label, value, sub = false }: { label: string; value: string; sub?: boolean }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-6', sub && 'pl-3 text-ink-tertiary')}>
      <span className={sub ? undefined : 'text-ink-secondary'}>{label}</span>
      <span className={sub ? undefined : 'text-ink'}>{value}</span>
    </div>
  );
}

export function ContextRing({ context, usage }: { context: { tokens: number; window: number }; usage: ThreadUsage | null }) {
  const percent = Math.min(100, Math.round((context.tokens / context.window) * 100));
  const tone = percent >= 95 ? 'text-danger' : percent >= 80 ? 'text-warning' : 'text-ink';
  const fill = percent >= 95 ? 'bg-danger' : percent >= 80 ? 'bg-warning' : 'bg-ink';

  const input = usage?.inputTokens ?? 0;
  const cached = usage === null || usage.calls === 0 ? 0 : usage.cachedInputTokens;
  const cachedText =
    cached === null
      ? t('main.usageUnknownCache')
      : input > 0
        ? t('main.usageCachedRate', { tokens: formatTokens(cached), percent: Math.round((cached / input) * 100) })
        : formatTokens(cached);

  const details = (
    <div className="flex w-[220px] flex-col gap-1.5 text-[12px] leading-4 tabular-nums">
      <div className="flex items-baseline justify-between gap-6">
        <span className="font-medium text-ink">{t('main.contextTitle')}</span>
        <span className="text-ink-secondary">{percent}%</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-ink/10">
        <div className={cn('h-full rounded-full', fill)} style={{ width: `${percent}%` }} />
      </div>
      <span className="text-ink-tertiary">
        {t('main.contextDetail', { tokens: formatTokens(context.tokens), window: formatTokens(context.window) })}
      </span>
      <div role="separator" className={cn(MENU_SEPARATOR, 'mx-0')} />
      <span className="font-medium text-ink">{t('main.usageTitle')}</span>
      <Row label={t('main.usageInput')} value={formatTokens(input)} />
      <Row label={t('main.usageCached')} value={cachedText} sub />
      <Row label={t('main.usageOutput')} value={formatTokens(usage?.outputTokens ?? 0)} />
      <Row label={t('main.usageCallsLabel')} value={t('main.usageCalls', { calls: usage?.calls ?? 0 })} />
    </div>
  );
  return (
    <HoverCard content={details} label={t('main.context', { percent })}>
      <svg viewBox="0 0 16 16" className={cn('size-4 shrink-0', tone)} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <circle cx="8" cy="8" r={RADIUS} strokeOpacity="0.18" />
        {percent > 0 && (
          <circle
            cx="8"
            cy="8"
            r={RADIUS}
            strokeLinecap="round"
            strokeDasharray={`${(CIRCUMFERENCE * percent) / 100} ${CIRCUMFERENCE}`}
            transform="rotate(-90 8 8)"
          />
        )}
      </svg>
      <span className="text-[12px] tabular-nums">{percent}%</span>
    </HoverCard>
  );
}
