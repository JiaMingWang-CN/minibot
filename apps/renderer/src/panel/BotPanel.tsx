// bot 侧板：对话区右边 320px。顶部是设置齿轮与关闭按钮，下面是 bot 头像与名字（点名字改名），
// 再下面两个标签：详情（模型、本对话、设置入口）与资料库（记忆、工作目录）。点行进入子页，左上角返回。
// 布局照 OpenMausBot 的 bot 面板。

import { useRef, useState, type KeyboardEvent } from 'react';
import type { Bot, KernelState, ThreadUsage } from '@minibot/core';
import { Pencil, Settings, X } from 'lucide-react';
import type { Api, BotPatch, PresetWithModels } from '../api';
import { Logo } from '../brand/Logo';
import { cn } from '../lib/cn';
import { t, type MessageKey } from '../i18n';
import type { SettingsPageId } from '../settings/SettingsDialog';
import { DetailsTab } from './DetailsTab';
import { FolderPage } from './FolderPage';
import { LibraryTab } from './LibraryTab';
import { MemoryFilePage, MemoryPage } from './MemoryPage';
import { PageHeader, roundButtonCls } from './rows';
import { SettingsPage } from './SettingsPage';

type Tab = 'details' | 'library';
export type PanelPage = { id: 'settings' } | { id: 'memory' } | { id: 'folder' } | { id: 'memoryFile'; name: string; path: string };

const TABS: { id: Tab; label: MessageKey }[] = [
  { id: 'details', label: 'panel.tab.details' },
  { id: 'library', label: 'panel.tab.library' },
];

const PAGE_HOME: Record<PanelPage['id'], Tab> = { settings: 'details', memory: 'library', folder: 'library', memoryFile: 'library' };

export interface PanelContext {
  api: Api;
  bot: Bot;
  patch: (patch: BotPatch) => Promise<void>;
  providers: KernelState['providers'];
  presets: PresetWithModels[];
  usage: ThreadUsage | null;
  isRunning: boolean;
  threadId: string | null;
  onCompact: () => void;
  onOpenSettings: (page: SettingsPageId) => void;
  onOpenAllowlist: () => void;
  open: (page: PanelPage) => void;
}

function pageTitle(page: PanelPage, name: string): string {
  if (page.id === 'memoryFile') return page.name;
  return t(`panel.page.${page.id}` as MessageKey, { name });
}

export function BotPanel({ onClose, ...context }: Omit<PanelContext, 'open'> & { onClose: () => void }) {
  const { bot, patch } = context;
  const [tab, setTab] = useState<Tab>('details');
  const [stack, setStack] = useState<PanelPage[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const page = stack.at(-1) ?? null;

  const scrollTop = (): void => body.current?.scrollTo({ top: 0 });
  const open = (next: PanelPage): void => {
    setStack((s) => [...s, next]);
    scrollTop();
  };
  const go = (next: PanelPage): void => {
    setTab(PAGE_HOME[next.id]);
    setStack([next]);
    scrollTop();
  };
  const back = (): void => {
    setStack((s) => s.slice(0, -1));
    scrollTop();
  };
  const backLabel = stack.length > 1 ? pageTitle(stack[stack.length - 2]!, bot.name) : t(TABS.find((x) => x.id === tab)!.label);

  const commitName = (): void => {
    const next = renaming?.trim() ?? '';
    setRenaming(null);
    if (next !== '' && next !== bot.name) void patch({ name: next });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (stack.length > 0) back();
    else onClose();
    e.preventDefault();
  };

  const ctx: PanelContext = { ...context, open };

  return (
    <aside aria-label={t('panel.title', { name: bot.name })} onKeyDown={onKeyDown} className="flex w-[320px] min-w-0 shrink-0 animate-fade-in flex-col border-l-[0.5px] border-ink/[0.06] bg-app">
      <div className="flex h-[50px] shrink-0 items-start justify-end gap-2.5 px-[13px] pt-[13px]">
        <button
          type="button"
          aria-label={t('panel.page.settings')}
          title={t('panel.page.settings')}
          aria-current={page?.id === 'settings' ? 'page' : undefined}
          onClick={() => go({ id: 'settings' })}
          className={roundButtonCls}>
          <Settings size={16} aria-hidden />
        </button>
        <button type="button" onClick={onClose} aria-label={t('panel.close')} className={roundButtonCls}>
          <X size={16} aria-hidden />
        </button>
      </div>

      <div ref={body} className="relative min-h-0 flex-1 overflow-y-auto px-4 pb-7">
        {page === null ? (
          <>
            <div className="mt-3.5 flex flex-col items-center text-center">
              <Logo size={64} />
              <div className="mt-2 flex max-w-full items-center justify-center">
                {renaming !== null ? (
                  <input
                    autoFocus
                    aria-label={t('panel.name')}
                    value={renaming}
                    onChange={(e) => setRenaming(e.target.value)}
                    onBlur={commitName}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing) return;
                      if (e.key === 'Enter') commitName();
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setRenaming(null);
                      }
                    }}
                    className="w-[220px] max-w-full rounded-lg border-[0.5px] border-ink/40 bg-inset px-2 py-[3px] text-center text-[17px] leading-6 font-medium text-ink outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    title={t('panel.rename')}
                    onClick={() => setRenaming(bot.name)}
                    className="group/name relative inline-flex max-w-full items-center rounded-[8px] px-1.5 text-[17px] leading-6 font-medium text-ink hover:bg-ink/[0.04]">
                    <span className="min-w-0 truncate">{bot.name}</span>
                    <Pencil size={13} aria-hidden className="absolute -right-4 shrink-0 text-ink-tertiary opacity-0 transition-opacity group-hover/name:opacity-100" />
                  </button>
                )}
              </div>
            </div>
            <div
              role="tablist"
              aria-label={t('panel.tabs')}
              className="sticky top-0 z-[1] -mx-4 mt-[15px] flex justify-center bg-app px-4 pt-1 pb-2.5">
              <div className="flex min-w-0 gap-0.5 rounded-full bg-ink/[0.05] p-[3px]">
                {TABS.map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === x.id}
                    onClick={() => setTab(x.id)}
                    className={cn(
                      'h-[26px] min-w-0 shrink truncate rounded-full px-3 text-[13px] leading-[18px] transition-colors',
                      tab === x.id ? 'bg-ink/[0.1] font-medium text-ink' : 'text-ink-secondary hover:text-ink',
                    )}>
                    {t(x.label)}
                  </button>
                ))}
              </div>
            </div>
            <div role="tabpanel">{tab === 'details' ? <DetailsTab {...ctx} /> : <LibraryTab {...ctx} />}</div>
          </>
        ) : (
          <div>
            <PageHeader back={backLabel} title={pageTitle(page, bot.name)} onBack={back} />
            <div className="mt-4 flex flex-col gap-3">
              {page.id === 'settings' && <SettingsPage {...ctx} />}
              {page.id === 'memory' && <MemoryPage {...ctx} />}
              {page.id === 'folder' && <FolderPage {...ctx} />}
              {page.id === 'memoryFile' && <MemoryFilePage key={page.path} {...ctx} path={page.path} />}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
