import { useRef, useState } from 'react';
import type { Bot, Thread } from '@minibot/core';
import { Bot as BotIcon, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { cn } from '@renderer/lib/cn';
import { t } from '@renderer/i18n';
import { Menu } from '@renderer/ui/Menu';
import { ICON_BUTTON, MENU_ROW, MENU_SHEET } from '@renderer/ui/recipes';
import { Popover } from '@renderer/ui/Popover';

/** 距离现在多久：同一天显示时分，否则显示月日 */
function when(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export function ThreadListScreen({
  bot,
  bots,
  threads,
  running,
  waiting,
  onSelectBot,
  onOpen,
  onNew,
  onRename,
  onDelete,
}: {
  bot: Bot;
  bots: Bot[];
  threads: Thread[];
  running: ReadonlySet<string>;
  waiting: ReadonlySet<string>;
  onSelectBot: (id: string) => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: (thread: Thread) => void;
  onDelete: (thread: Thread) => void;
}) {
  const [botsOpen, setBotsOpen] = useState(false);
  const botButton = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-app">
      <header className="flex h-12 shrink-0 items-center gap-2 px-3">
        <button
          ref={botButton}
          type="button"
          aria-label={t('mobile.threads.bots')}
          aria-expanded={botsOpen}
          className={cn(ICON_BUTTON, 'w-auto gap-1.5 px-2')}
          onClick={() => setBotsOpen((o) => !o)}>
          <BotIcon size={16} aria-hidden />
          <span className="max-w-[160px] truncate text-[14px] font-medium">{bot.name}</span>
        </button>
        <Popover anchor={botButton} open={botsOpen} onClose={() => setBotsOpen(false)} align="start" width={220}>
          <div role="menu" className={MENU_SHEET}>
            {bots.map((b) => (
              <button
                key={b.id}
                type="button"
                role="menuitem"
                className={MENU_ROW}
                onClick={() => {
                  setBotsOpen(false);
                  onSelectBot(b.id);
                }}>
                <span className="min-w-0 flex-1 truncate text-left">{b.name}</span>
              </button>
            ))}
          </div>
        </Popover>
        <h1 className="sr-only">{t('mobile.threads.title')}</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pb-24">
        {threads.length === 0 ? (
          <p className="px-6 py-16 text-center text-[13px] text-ink-secondary">{t('mobile.threads.empty')}</p>
        ) : (
          <ul>
            {threads.map((th) => (
              <li key={th.id} className="flex items-center border-b-[0.5px] border-edge">
                <button type="button" onClick={() => onOpen(th.id)} className="flex min-w-0 flex-1 flex-col gap-1 px-4 py-3 text-left">
                  <span className="truncate text-[15px]">{th.title}</span>
                  <span className="flex items-center gap-2 text-[12px] text-ink-tertiary">
                    {waiting.has(th.id) && <span className="font-medium text-warning">{t('mobile.threads.waiting')}</span>}
                    {running.has(th.id) && <span className="animate-pulse text-ink-secondary">{t('mobile.threads.running')}</span>}
                    <span>{when(th.lastActivityAt)}</span>
                  </span>
                </button>
                <Menu
                  align="end"
                  width={160}
                  items={[
                    { label: t('mobile.threads.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: () => onRename(th) },
                    { label: t('mobile.threads.delete'), icon: <Trash2 size={14} aria-hidden />, danger: true, onSelect: () => onDelete(th) },
                  ]}
                  trigger={(props) => (
                    <button type="button" aria-label={t('mobile.threads.more')} className={cn(ICON_BUTTON, 'mr-2')} {...props}>
                      <MoreHorizontal size={16} aria-hidden />
                    </button>
                  )}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <button
        type="button"
        aria-label={t('mobile.threads.new')}
        onClick={onNew}
        className="safe-bottom absolute right-5 bottom-5 flex size-14 items-center justify-center rounded-full bg-ink text-on-ink shadow-float">
        <Plus size={22} aria-hidden />
      </button>
    </div>
  );
}
