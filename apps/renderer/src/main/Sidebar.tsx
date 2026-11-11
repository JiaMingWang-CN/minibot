// 侧栏：顶行是 bot 名字与搜索、新对话两个按钮；点搜索才展开搜索框；下面是对话列表或搜索结果；底部是设置入口。

import { useEffect, useRef } from 'react';
import type { Bot, SearchHit, Thread } from '@minibot/core';
import { Loader2, MoreHorizontal, Plus, Search, Settings, ShieldAlert, X } from 'lucide-react';
import { Logo } from '../brand/Logo';
import { cn } from '../lib/cn';
import { t } from '../i18n';
import { Menu } from '../ui/Menu';
import { ICON_BUTTON, ICON_BUTTON_SM } from '../ui/recipes';

const ROW = 'group flex w-full min-w-0 items-center gap-2 rounded-lg px-3 text-left transition-colors';

export function Sidebar({
  bot,
  threads,
  activeId,
  running,
  waiting,
  searchOpen,
  query,
  hits,
  onSearchOpen,
  onQuery,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onSettings,
}: {
  bot: Bot;
  threads: Thread[];
  activeId: string | null;
  running: ReadonlySet<string>;
  /** 有请求在等批准的对话 */
  waiting: ReadonlySet<string>;
  searchOpen: boolean;
  query: string;
  hits: SearchHit[] | null;
  onSearchOpen: (open: boolean) => void;
  onQuery: (q: string) => void;
  onSelect: (threadId: string) => void;
  onNew: () => void;
  onRename: (thread: Thread) => void;
  onDelete: (thread: Thread) => void;
  onSettings: () => void;
}) {
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchOpen) search.current?.focus();
  }, [searchOpen]);

  return (
    <nav aria-label={t('main.nav')} className="flex w-[280px] shrink-0 flex-col border-r-[0.5px] border-edge bg-panel">
      <div className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-4">
        <Logo size={18} />
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{bot.name}</span>
        <button
          type="button"
          aria-label={t('main.search')}
          title={t('main.search')}
          aria-pressed={searchOpen}
          onClick={() => onSearchOpen(!searchOpen)}
          className={cn(ICON_BUTTON, searchOpen && 'bg-ink/[0.08] text-ink')}>
          <Search size={17} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" aria-label={t('main.newThread')} title={t('main.newThread')} onClick={onNew} className={ICON_BUTTON}>
          <Plus size={18} strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      {searchOpen && (
        <div className="px-3 pb-2">
          <div className="flex h-8 animate-pop-in items-center gap-2 rounded-full bg-inset px-3 focus-within:ring-[0.5px] focus-within:ring-hairline">
            <Search size={14} className="shrink-0 text-ink-tertiary" aria-hidden />
            <input
              ref={search}
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && onSearchOpen(false)}
              placeholder={t('main.search')}
              aria-label={t('main.search')}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-tertiary"
            />
            {query.length > 0 && (
              <button type="button" aria-label={t('main.clearSearch')} onClick={() => onQuery('')} className="text-ink-tertiary hover:text-ink">
                <X size={14} aria-hidden />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {hits !== null ? (
          hits.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-ink-tertiary">{t('main.noResults')}</p>
          ) : (
            hits.map((hit) => (
              <button
                key={hit.messageId}
                type="button"
                onClick={() => onSelect(hit.threadId)}
                className={cn(ROW, 'flex-col items-start gap-0.5 py-2', hit.threadId === activeId ? 'bg-raised' : 'hover:bg-ink/[0.04]')}>
                <span className="w-full truncate text-[13px] font-medium">{hit.threadTitle}</span>
                <span className="line-clamp-2 w-full text-[12px] leading-4 text-ink-secondary">{hit.snippet.replace(/\s+/g, ' ')}</span>
              </button>
            ))
          )
        ) : (
          threads.map((thread) => {
            const selected = thread.id === activeId;
            return (
              <div key={thread.id} className={cn(ROW, 'h-9 pr-1', selected ? 'bg-raised' : 'hover:bg-ink/[0.04]')}>
                <button
                  type="button"
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => onSelect(thread.id)}
                  className="h-full min-w-0 flex-1 truncate text-left text-[14px] outline-none">
                  {thread.title}
                </button>
                {waiting.has(thread.id) ? (
                  <ShieldAlert size={14} className="shrink-0 text-warning" aria-label={t('approval.waitingThread')} />
                ) : (
                  running.has(thread.id) && <Loader2 size={14} className="shrink-0 animate-spin text-ink-tertiary" aria-label={t('main.running')} />
                )}
                <Menu
                  align="start"
                  width={160}
                  items={[
                    { label: t('main.rename'), onSelect: () => onRename(thread) },
                    { label: t('main.delete'), danger: true, onSelect: () => onDelete(thread) },
                  ]}
                  trigger={(props) => (
                    <button
                      {...props}
                      type="button"
                      aria-label={t('main.threadActions')}
                      className={cn(ICON_BUTTON_SM, 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100')}>
                      <MoreHorizontal size={16} aria-hidden />
                    </button>
                  )}
                />
              </div>
            );
          })
        )}
      </div>

      <div className="shrink-0 px-2 pb-2">
        <button type="button" onClick={onSettings} className={cn(ROW, 'h-9 text-[14px] text-ink-secondary hover:bg-ink/[0.04] hover:text-ink')}>
          <Settings size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
          {t('settings.title')}
        </button>
      </div>
    </nav>
  );
}
