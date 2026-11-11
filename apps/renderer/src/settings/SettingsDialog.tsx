// 应用设置：居中大弹窗，左侧 198px 导航（搜索 + 页面），右侧页标题与分组卡片。布局照 OpenMausBot 的简洁设置。

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Bot, KernelState } from '@minibot/core';
import { Brain, KeyRound, ScrollText, Search, Smartphone, User, X, type LucideIcon } from 'lucide-react';
import type { Api, PresetWithModels } from '../api';
import type { Subscribe } from '../App';
import { cn } from '../lib/cn';
import { t, type MessageKey } from '../i18n';
import { ActivityPage } from './ActivityPage';
import { ConsolidationPage } from './ConsolidationPage';
import { GeneralPage } from './GeneralPage';
import { PhonePage } from './PhonePage';
import { ProvidersPage } from './ProvidersPage';

export type SettingsPageId = 'general' | 'providers' | 'consolidation' | 'activity' | 'phone';

/** keywords 是语言包里用空格分隔的搜索词 */
const PAGES: { id: SettingsPageId; label: MessageKey; icon: LucideIcon; keywords: MessageKey }[] = [
  { id: 'general', label: 'settings.page.general', icon: User, keywords: 'settings.keywords.general' },
  { id: 'providers', label: 'settings.page.providers', icon: KeyRound, keywords: 'settings.keywords.providers' },
  { id: 'consolidation', label: 'settings.page.consolidation', icon: Brain, keywords: 'settings.keywords.consolidation' },
  { id: 'activity', label: 'settings.page.activity', icon: ScrollText, keywords: 'settings.keywords.activity' },
  { id: 'phone', label: 'settings.page.phone', icon: Smartphone, keywords: 'settings.keywords.phone' },
];

export function SettingsDialog({
  api,
  bot,
  providers,
  presets,
  canPersistKeys,
  initialPage = 'general',
  memoryVersion,
  subscribe,
  onRefresh,
  onClose,
}: {
  memoryVersion: number;
  subscribe: Subscribe;
  api: Api;
  bot: Bot;
  providers: KernelState['providers'];
  presets: PresetWithModels[];
  canPersistKeys: boolean;
  initialPage?: SettingsPageId;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [page, setPage] = useState<SettingsPageId>(initialPage);
  const [query, setQuery] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();
  const visible = PAGES.filter((p) => q === '' || [t(p.label), ...t(p.keywords).split(' ')].some((k) => k.toLowerCase().includes(q)));
  const current = PAGES.find((p) => p.id === page)!;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // 里面还开着别的对话框时，Esc 归它
      if (document.querySelectorAll('[role="dialog"]').length > 1) return;
      onClose();
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [onClose]);

  // 搜索后当前页被筛掉，跳到第一个匹配的页
  useEffect(() => {
    if (visible.length > 0 && !visible.some((p) => p.id === page)) setPage(visible[0]!.id);
  }, [visible, page]);

  let body: ReactNode;
  if (page === 'general') body = <GeneralPage api={api} bot={bot} memoryVersion={memoryVersion} />;
  else if (page === 'providers')
    body = <ProvidersPage api={api} bot={bot} providers={providers} presets={presets} canPersistKeys={canPersistKeys} onRefresh={onRefresh} />;
  else if (page === 'consolidation') body = <ConsolidationPage api={api} providers={providers} presets={presets} />;
  else if (page === 'phone') body = <PhonePage api={api} subscribe={subscribe} />;
  else body = <ActivityPage api={api} />;

  return createPortal(
    <div className="no-drag fixed inset-0 z-50 flex animate-fade-in items-center justify-center px-4 py-12" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-black/20" />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
        tabIndex={-1}
        className="relative flex h-[min(700px,100%)] w-[min(860px,100%)] animate-pop-in overflow-hidden rounded-[12px] bg-app shadow-menu ring-[0.5px] ring-edge outline-none">
        <nav aria-label={t('settings.title')} className="flex min-h-0 w-[198px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r-[0.5px] border-edge px-3 py-4">
          <div className="mb-2 flex h-8 shrink-0 items-center gap-2 rounded-lg bg-ink/[0.05] px-[9px] focus-within:ring-2 focus-within:ring-focus">
            <Search size={15} aria-hidden className="shrink-0 text-ink-secondary" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query !== '') {
                  e.preventDefault();
                  setQuery('');
                }
              }}
              placeholder={t('settings.search')}
              aria-label={t('settings.search')}
              className="w-full min-w-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-secondary"
            />
          </div>
          {visible.length === 0 && <div className="px-[9px] py-3 text-[13px] leading-[18px] text-ink-secondary">{t('settings.noMatch', { query: query.trim() })}</div>}
          {visible.map((p) => {
            const Icon = p.icon;
            return (
              <button
                key={p.id}
                type="button"
                aria-current={p.id === page ? 'page' : undefined}
                onClick={() => setPage(p.id)}
                className={cn(
                  'flex h-8 shrink-0 items-center gap-[9px] rounded-lg px-[9px] text-left text-[13px] text-ink transition-colors',
                  p.id === page ? 'bg-ink/[0.08]' : 'hover:bg-ink/[0.06]',
                )}>
                <Icon size={15} aria-hidden className="shrink-0" />
                <span className="truncate">{t(p.label)}</span>
              </button>
            );
          })}
        </nav>

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center gap-3 pt-8 pr-14 pb-1.5 pl-12">
            <h2 className="truncate text-[17px] leading-6 font-medium tracking-[-0.008em] text-ink">{t(current.label)}</h2>
          </header>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('settings.close')}
            className="absolute top-[18px] right-5 flex size-8 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink">
            <X size={16} aria-hidden />
          </button>
          <div key={page} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-8 pt-[22px] pb-12">
            {body}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
