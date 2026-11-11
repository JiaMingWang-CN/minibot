// 主界面：外框顶栏（显示当前对话）→ 左侧 280px 侧栏 + 右侧对话区。
// 对话区：半透明的聊天头浮在消息上（左空 / 中间 bot / 右边上下文、模型、更多），
// 消息列最宽 48rem 居中，输入框胶囊在底部。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalRequest, Bot, KernelEvent, KernelState, SearchHit, StoredMessage, Thread, ThreadUsage } from '@minibot/core';
import { ArrowDown, MoreHorizontal, X } from 'lucide-react';
import type { Subscribe } from '../App';
import { fileToBase64, type Api, type BotPatch, type EventConnection, type PresetWithModels } from '../api';
import { Logo } from '../brand/Logo';
import { FrameBar } from '../FrameBar';
import { cn } from '../lib/cn';
import { t } from '../i18n';
import { Dialog } from '../ui/Dialog';
import { Menu } from '../ui/Menu';
import { FIELD, ICON_BUTTON, PILL_DANGER, PILL_PRIMARY, PILL_SECONDARY } from '../ui/recipes';
import { ApprovalCard } from './ApprovalCard';
import { ApprovalModePicker } from './ApprovalModePicker';
import { Composer, IMAGE_TYPES, type PendingImage } from './Composer';
import { ContextRing } from './ContextRing';
import { ModelPicker } from './ModelPicker';
import { CommandAllowlistDialog } from './CommandAllowlistDialog';
import { BotPanel } from '../panel/BotPanel';
import { SettingsDialog, type SettingsPageId } from '../settings/SettingsDialog';
import { Sidebar } from './Sidebar';
import { MarkdownText, SystemLine, Transcript, textOf } from './Transcript';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 离底部这么近时算“跟随最新”，新内容会自动滚到底 */
const STICK_DISTANCE = 80;

interface Streaming {
  text: string;
  reasoning: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function MainScreen({
  api,
  events,
  subscribe,
  bot,
  providers,
  presets,
  onBotChange,
  secretsUnreadable,
  canPersistKeys,
  onRefresh,
}: {
  api: Api;
  events: EventConnection;
  subscribe: Subscribe;
  bot: Bot;
  providers: KernelState['providers'];
  presets: PresetWithModels[];
  onBotChange: (bot: Bot) => void;
  secretsUnreadable: boolean;
  canPersistKeys: boolean;
  /** 重新读内核状态（供应商有变化后） */
  onRefresh: () => Promise<void>;
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPageId | null>(null);
  const [allowlistOpen, setAllowlistOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsPage(null), []);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [usage, setUsage] = useState<ThreadUsage | null>(null);
  const [context, setContext] = useState<{ tokens: number; window: number } | null>(null);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const [steered, setSteered] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [renaming, setRenaming] = useState<Thread | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<Thread | null>(null);
  const [failure, setFailure] = useState<string | null>(secretsUnreadable ? t('app.secretsUnreadable') : null);
  const [stuck, setStuck] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  const active = threads.find((th) => th.id === activeId) ?? null;
  const isRunning = activeId !== null && running.has(activeId);

  const refreshThreads = useCallback(async (): Promise<Thread[]> => {
    const list = await api.listThreads(bot.id);
    setThreads(list);
    return list;
  }, [api, bot.id]);

  const refreshStats = useCallback(
    (threadId: string): void => {
      void api.usage(threadId).then((u) => activeRef.current === threadId && setUsage(u)).catch(() => {});
      void api.context(threadId).then((c) => activeRef.current === threadId && setContext(c)).catch(() => {});
    },
    [api],
  );

  // 首次进入：读对话列表（没有就建一个）与待审批
  useEffect(() => {
    void (async () => {
      try {
        let list = await refreshThreads();
        if (list.length === 0) {
          await api.createThread(bot.id);
          list = await refreshThreads();
        }
        setActiveId((current) => current ?? list[0]?.id ?? null);
        setApprovals(await api.pendingApprovals());
      } catch (err) {
        setFailure(errorText(err));
      }
    })();
  }, [api, bot.id, refreshThreads]);

  // 切换对话：读消息与用量，回到底部
  useEffect(() => {
    setMessages([]);
    setStreaming(null);
    setUsage(null);
    setContext(null);
    setRetryNote(null);
    setSteered([]);
    setStuck(true);
    if (activeId === null) return;
    let cancelled = false;
    api
      .listMessages(activeId)
      .then((list) => !cancelled && setMessages(list))
      .catch((err: unknown) => setFailure(errorText(err)));
    refreshStats(activeId);
    return () => {
      cancelled = true;
    };
  }, [api, activeId, refreshStats]);

  // 切换模型后上下文窗口跟着变，重新取一次占用
  useEffect(() => {
    if (activeRef.current !== null) refreshStats(activeRef.current);
  }, [bot.contextWindow, refreshStats]);

  // 内核事件
  useEffect(
    () =>
      subscribe((event: KernelEvent) => {
        const current = activeRef.current;
        switch (event.type) {
          case 'message':
            if (event.threadId !== current) return;
            setMessages((list) => (list.some((m) => m.id === event.message.id) ? list : [...list, event.message]));
            if (event.message.role === 'assistant') setStreaming(null);
            if (event.message.role === 'user' && event.message.kind === null) {
              const text = textOf(event.message.blocks);
              setSteered((list) => list.filter((s) => s !== text));
            }
            return;
          case 'delta':
            if (event.threadId !== current) return;
            setRetryNote(null);
            setStreaming((s) => {
              const base = s ?? { text: '', reasoning: '' };
              return event.delta.type === 'text'
                ? { ...base, text: base.text + event.delta.text }
                : { ...base, reasoning: base.reasoning + event.delta.text };
            });
            return;
          case 'turn':
            setRunning((set) => {
              const next = new Set(set);
              if (event.state === 'running') next.add(event.threadId);
              else next.delete(event.threadId);
              return next;
            });
            if (event.state === 'idle') {
              void refreshThreads().catch(() => {});
              if (event.threadId === current) {
                setStreaming(null);
                setRetryNote(null);
                setSteered([]);
                refreshStats(event.threadId);
              }
            }
            return;
          case 'retry':
            if (event.threadId !== current) return;
            setRetryNote(
              t('main.retrying', { seconds: Math.round(event.delayMs / 1000), attempt: event.attempt, message: event.message }),
            );
            return;
          case 'approval_request':
            setApprovals((list) => [...list, event.request]);
            return;
          case 'approval_resolved':
            setApprovals((list) => list.filter((a) => a.id !== event.id));
            return;
          case 'messages_deleted':
            if (event.threadId !== current) return;
            setMessages((list) => list.filter((m) => m.id < event.fromId));
            return;
          case 'thread_deleted':
            setThreads((list) => list.filter((th) => th.id !== event.threadId));
            return;
          default:
        }
      }),
    [subscribe, refreshThreads, refreshStats],
  );

  // 搜索：输入停顿 250ms 后查询
  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      setHits(null);
      return;
    }
    const timer = setTimeout(() => {
      api
        .search(q, bot.id)
        .then(setHits)
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [api, bot.id, query]);

  // 跟随最新：有新内容时滚到底
  useEffect(() => {
    const el = scroller.current;
    if (el !== null && stuck) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, approvals, retryNote, steered, stuck]);

  const jumpToLatest = (): void => {
    const el = scroller.current;
    if (el !== null) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const openSearch = (open: boolean): void => {
    setSearchOpen(open);
    if (!open) setQuery('');
  };

  const patchBot = async (patch: BotPatch): Promise<void> => {
    onBotChange(await api.updateBot(bot.id, patch));
  };
  const changeModel = (patch: BotPatch): void => {
    patchBot(patch).catch((err: unknown) => setFailure(errorText(err)));
  };
  const compact = (): void => {
    if (activeId !== null) api.compact(activeId).catch((err: unknown) => setFailure(errorText(err)));
  };

  const newThread = async (): Promise<void> => {
    try {
      const thread = await api.createThread(bot.id);
      await refreshThreads();
      openSearch(false);
      setActiveId(thread.id);
    } catch (err) {
      setFailure(errorText(err));
    }
  };

  const addImages = (files: File[]): void => {
    setComposerError(null);
    const accepted: PendingImage[] = [];
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type)) {
        setComposerError(t('main.imageType'));
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setComposerError(t('main.imageTooBig', { name: file.name }));
        continue;
      }
      accepted.push({ file, url: URL.createObjectURL(file) });
    }
    setImages((list) => {
      const room = MAX_IMAGES - list.length;
      if (accepted.length > room) setComposerError(t('main.imageLimit'));
      for (const extra of accepted.slice(Math.max(room, 0))) URL.revokeObjectURL(extra.url);
      return [...list, ...accepted.slice(0, Math.max(room, 0))];
    });
  };

  const removeImage = (url: string): void => {
    URL.revokeObjectURL(url);
    setImages((list) => list.filter((i) => i.url !== url));
  };

  const send = async (): Promise<void> => {
    if (activeId === null) return;
    const text = draft.trim();
    if (text.length === 0 && images.length === 0) return;
    setComposerError(null);
    try {
      const payload = await Promise.all(images.map(async (i) => ({ mediaType: i.file.type, data: await fileToBase64(i.file) })));
      const result = await api.sendMessage(activeId, text, payload);
      for (const i of images) URL.revokeObjectURL(i.url);
      setImages([]);
      setDraft('');
      setStuck(true);
      if (result.mode === 'steer' && text.length > 0) setSteered((list) => [...list, text]);
    } catch (err) {
      setComposerError(errorText(err));
    }
  };

  const retry = async (): Promise<void> => {
    if (activeId === null) return;
    try {
      await api.retry(activeId);
    } catch (err) {
      setFailure(errorText(err));
    }
  };

  const confirmRename = async (): Promise<void> => {
    if (renaming === null || renameValue.trim().length === 0) return;
    try {
      await api.renameThread(renaming.id, renameValue.trim());
      await refreshThreads();
      setRenaming(null);
    } catch (err) {
      setFailure(errorText(err));
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (deleting === null) return;
    const id = deleting.id;
    try {
      await api.deleteThread(id);
      setDeleting(null);
      const list = await refreshThreads();
      if (activeRef.current === id) setActiveId(list[0]?.id ?? null);
    } catch (err) {
      setFailure(errorText(err));
    }
  };

  const startRename = (thread: Thread): void => {
    setRenameValue(thread.title);
    setRenaming(thread);
  };
  const closeRename = useCallback(() => setRenaming(null), []);
  const closeDelete = useCallback(() => setDeleting(null), []);

  const activeApprovals = approvals.filter((a) => a.threadId === activeId);
  const lastMessage = messages[messages.length - 1];
  const canRetry = !isRunning && lastMessage !== undefined && lastMessage.kind === 'notice';
  const showStreaming = streaming !== null && (streaming.text.length > 0 || streaming.reasoning.length > 0);
  const empty = messages.length === 0 && !showStreaming;

  return (
    <div className="flex h-full flex-col bg-frame">
      <FrameBar title={active?.title ?? t('main.noThread')} />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          bot={bot}
          threads={threads}
          activeId={activeId}
          running={running}
          searchOpen={searchOpen}
          query={query}
          hits={hits}
          onSearchOpen={openSearch}
          onQuery={setQuery}
          onSelect={setActiveId}
          onNew={() => void newThread()}
          onRename={startRename}
          onDelete={setDeleting}
          onSettings={() => setSettingsPage('general')}
        />

        <main className="relative flex min-w-0 flex-1 flex-col bg-app">
          {/* 聊天头：半透明，浮在消息上；两侧等宽，中间的 bot 因此居中 */}
          <header className="absolute inset-x-0 top-0 z-10 grid h-14 grid-cols-[1fr_auto_1fr] items-center gap-3 bg-app/80 px-4 backdrop-blur-md">
            <span />
            <button
              type="button"
              aria-expanded={panelOpen}
              title={t('panel.open')}
              onClick={() => setPanelOpen((o) => !o)}
              className="flex min-w-0 items-center gap-2 rounded-full py-1 pr-3 pl-2 transition-colors hover:bg-ink/[0.06] aria-expanded:bg-ink/[0.08]">
              <Logo size={20} />
              <h1 className="truncate text-[14px] font-medium">{bot.name}</h1>
            </button>
            <div className="flex min-w-0 items-center justify-end gap-1">
              {context !== null && context.window > 0 && <ContextRing context={context} usage={usage} />}
              <ModelPicker bot={bot} providers={providers} presets={presets} isDisabled={isRunning} onChange={changeModel} />
              {active !== null && (
                <Menu
                  align="end"
                  items={[
                    { label: t('main.rename'), onSelect: () => startRename(active) },
                    { label: t('main.delete'), danger: true, onSelect: () => setDeleting(active) },
                    { type: 'separator' },
                    { label: t('main.compact'), disabled: isRunning, onSelect: compact },
                    { label: t('main.openMemory'), onSelect: () => void window.minibot.openMemoryDir(bot.id).catch(() => {}) },
                    { type: 'separator' },
                    { label: t('panel.open'), onSelect: () => setPanelOpen(true) },
                  ]}
                  trigger={(props) => (
                    <button {...props} type="button" aria-label={t('main.threadActions')} className={ICON_BUTTON}>
                      <MoreHorizontal size={18} aria-hidden />
                    </button>
                  )}
                />
              )}
            </div>
          </header>

          <div
            ref={scroller}
            className="min-h-0 flex-1 overflow-y-auto px-5"
            onScroll={(e) => {
              const el = e.currentTarget;
              setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < STICK_DISTANCE);
            }}>
            <div role="log" aria-label={t('main.conversation', { name: bot.name })} className="chat-column flex min-h-full flex-col gap-5 pt-18 pb-6">
              {failure !== null && (
                <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger">
                  <span className="min-w-0 flex-1 break-words">{failure}</span>
                  <button type="button" aria-label={t('main.dismiss')} onClick={() => setFailure(null)} className="shrink-0 opacity-70 hover:opacity-100">
                    <X size={14} aria-hidden />
                  </button>
                </div>
              )}
              {empty ? (
                <div className="m-auto flex animate-rise flex-col items-center gap-3 text-center">
                  <Logo size={48} />
                  <h2 className="text-[22px] tracking-[-0.01em]">{t('main.emptyTitle', { name: bot.name })}</h2>
                  <p className="max-w-[360px] text-[13px] leading-[18px] text-ink-secondary">{t('main.emptyBody')}</p>
                </div>
              ) : (
                <>
                  <Transcript
                    api={api}
                    messages={messages}
                    running={isRunning}
                    noticeAction={
                      canRetry ? (
                        <button type="button" className={cn(PILL_SECONDARY, 'h-7 px-3 text-[13px]')} onClick={() => void retry()}>
                          {t('main.retry')}
                        </button>
                      ) : undefined
                    }
                  />
                  {showStreaming && (
                    <div className="flex flex-col gap-2">
                      {streaming.text.length > 0 ? (
                        <MarkdownText streaming>{streaming.text}</MarkdownText>
                      ) : (
                        <span className="animate-pulse text-[13px] text-ink-secondary">{t('main.thinkingNow')}</span>
                      )}
                    </div>
                  )}
                  {isRunning && !showStreaming && lastMessage?.role === 'user' && (
                    <span className="animate-pulse text-[13px] text-ink-tertiary">{t('main.waiting')}</span>
                  )}
                  {retryNote !== null && <SystemLine>{retryNote}</SystemLine>}
                  {steered.map((text, i) => (
                    <SystemLine key={`${i}-${text}`}>{t('main.steerQueued', { text })}</SystemLine>
                  ))}
                </>
              )}
            </div>
          </div>

          <footer className="relative shrink-0 px-5 pb-4">
            {!stuck && !empty && (
              <button
                type="button"
                aria-label={t('main.jumpToLatest')}
                onClick={jumpToLatest}
                className={cn(ICON_BUTTON, 'absolute -top-11 left-1/2 -translate-x-1/2 animate-pop-in bg-composer shadow-float ring-[0.5px] ring-ink/10')}>
                <ArrowDown size={16} aria-hidden />
              </button>
            )}
            <div className="chat-column">
              <Composer
                value={draft}
                onChange={setDraft}
                onSubmit={() => void send()}
                onStop={() => activeId !== null && events.send({ type: 'abort', threadId: activeId })}
                running={isRunning}
                disabled={activeId === null}
                placeholder={isRunning ? t('main.placeholderRunning') : t('main.placeholder', { name: bot.name })}
                images={images}
                canAddImage={images.length < MAX_IMAGES}
                onAddImages={addImages}
                onRemoveImage={removeImage}
                error={composerError}
                tools={
                  <ApprovalModePicker
                    mode={bot.approvalMode}
                    disabled={isRunning}
                    onChange={(approvalMode) => changeModel({ approvalMode })}
                    onManageAllowlist={() => setAllowlistOpen(true)}
                  />
                }
                above={activeApprovals.map((request) => (
                  <ApprovalCard
                    key={request.id}
                    request={request}
                    onRespond={(approve, always) => events.send({ type: 'approval', id: request.id, approve, always })}
                  />
                ))}
              />
            </div>
          </footer>
        </main>

        {panelOpen && (
          <BotPanel
            api={api}
            bot={bot}
            patch={patchBot}
            providers={providers}
            presets={presets}
            usage={usage}
            isRunning={isRunning}
            threadId={activeId}
            onCompact={compact}
            onOpenSettings={setSettingsPage}
            onOpenAllowlist={() => setAllowlistOpen(true)}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </div>

      {settingsPage !== null && (
        <SettingsDialog
          api={api}
          bot={bot}
          providers={providers}
          presets={presets}
          canPersistKeys={canPersistKeys}
          initialPage={settingsPage}
          onRefresh={onRefresh}
          onClose={closeSettings}
        />
      )}
      {allowlistOpen && <CommandAllowlistDialog bot={bot} patch={patchBot} onClose={() => setAllowlistOpen(false)} />}

      <Dialog
        open={renaming !== null}
        onClose={closeRename}
        title={t('main.renameTitle')}
        footer={
          <>
            <button type="button" className={PILL_SECONDARY} onClick={closeRename}>
              {t('common.cancel')}
            </button>
            <button type="button" className={PILL_PRIMARY} disabled={renameValue.trim().length === 0} onClick={() => void confirmRename()}>
              {t('common.save')}
            </button>
          </>
        }>
        <input
          className={FIELD}
          aria-label={t('main.renameLabel')}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void confirmRename()}
        />
      </Dialog>

      <Dialog
        open={deleting !== null}
        onClose={closeDelete}
        title={t('main.deleteTitle', { title: deleting?.title ?? '' })}
        footer={
          <>
            <button type="button" className={PILL_SECONDARY} onClick={closeDelete}>
              {t('common.cancel')}
            </button>
            <button type="button" className={PILL_DANGER} onClick={() => void confirmDelete()}>
              {t('common.delete')}
            </button>
          </>
        }>
        <p className="text-[14px] text-ink-secondary">{t('main.deleteBody')}</p>
      </Dialog>
    </div>
  );
}
