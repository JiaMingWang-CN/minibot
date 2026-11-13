import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot, KernelEvent, KernelState, Thread } from '@minibot/core';
import { Loader2 } from 'lucide-react';
import { createApi, type Api, type EventConnection } from '@renderer/api';
import { cn } from '@renderer/lib/cn';
import { t } from '@renderer/i18n';
import { useConversation } from '@renderer/main/useConversation';
import { ThreadDialogs } from '@renderer/main/ThreadDialogs';
import { Dialog } from '@renderer/ui/Dialog';
import { PILL_PRIMARY, PILL_SECONDARY } from '@renderer/ui/recipes';
import { ApprovalBar } from './ApprovalBar';
import { MinibotRemote } from './native';
import { PairScreen } from './screens/PairScreen';
import { ConversationScreen } from './screens/ConversationScreen';
import { SettingsScreen, viaText } from './screens/SettingsScreen';
import { ThreadListScreen } from './screens/ThreadListScreen';
import { nativeEvents, nativeTransport } from './transport';
import { UpdatePrompt } from './UpdatePrompt';
import { FeedbackSheet } from './screens/FeedbackSheet';
import { usePhoneStatus } from './usePhoneStatus';

type Subscribe = (listener: (event: KernelEvent) => void) => () => void;

interface Boot {
  api: Api;
  events: EventConnection;
  subscribe: Subscribe;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readStoredBot(): string | null {
  try {
    return localStorage.getItem('minibot.mobile.bot');
  } catch {
    return null;
  }
}

/** 已连接后的主体：读 bot 列表、对话列表 ↔ 对话页 */
function Connected({ boot, onSettings, view, setView, setLaunchHandler }: {
  boot: Boot;
  onSettings: () => void;
  view: 'list' | 'chat';
  setView: (view: 'list' | 'chat') => void;
  setLaunchHandler: (open: ((threadId: string) => void) | null) => void;
}) {
  const { api, events, subscribe } = boot;
  const [state, setState] = useState<KernelState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [botId, setBotId] = useState<string | null>(readStoredBot());

  const load = useCallback(() => {
    setLoadError(null);
    api.state().then(setState).catch((err: unknown) => setLoadError(t('mobile.loadFailed', { message: errorText(err) })));
  }, [api]);
  useEffect(load, [load]);
  // 断线重连后重新读一次（先前可能因离线失败）
  useEffect(() => events.onOpen(load), [events, load]);

  if (state === null) {
    return (
      <div className="m-auto flex flex-col items-center gap-3 text-[13px] text-ink-secondary">
        {loadError === null ? (
          <>
            <Loader2 size={16} className="animate-spin" aria-hidden />
            {t('mobile.connecting')}
          </>
        ) : (
          <>
            <p role="alert" className="max-w-[300px] text-center text-danger">{loadError}</p>
            <button type="button" className={cn(PILL_SECONDARY, 'h-9')} onClick={load}>
              {t('mobile.retry')}
            </button>
          </>
        )}
      </div>
    );
  }
  const bot = state.bots.find((b) => b.id === botId) ?? state.bots.find((b) => b.id === state.mainBotId) ?? state.bots[0];
  if (bot === undefined) return null;
  return (
    <BotView
      key={bot.id}
      api={api}
      events={events}
      subscribe={subscribe}
      bot={bot}
      bots={state.bots}
      onSelectBot={(id) => {
        setBotId(id);
        try {
          localStorage.setItem('minibot.mobile.bot', id);
        } catch {
          // 记不住也不影响使用
        }
      }}
      view={view}
      setView={setView}
      onSettings={onSettings}
      setLaunchHandler={setLaunchHandler}
    />
  );
}

function BotView({ api, events, subscribe, bot, bots, onSelectBot, view, setView, onSettings, setLaunchHandler }: {
  api: Api;
  events: EventConnection;
  subscribe: Subscribe;
  bot: Bot;
  bots: Bot[];
  onSelectBot: (id: string) => void;
  view: 'list' | 'chat';
  setView: (view: 'list' | 'chat') => void;
  onSettings: () => void;
  setLaunchHandler: (open: ((threadId: string) => void) | null) => void;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Thread | null>(null);
  const [deleting, setDeleting] = useState<Thread | null>(null);
  const conv = useConversation({ api, events, subscribe, botId: bot.id, contextWindow: bot.contextWindow, withContext: false, autoCreate: false, onError: setFailure });
  const { threads, activeId, setActiveId, running, approvals, refreshThreads, activeRef } = conv;

  const open = useCallback(
    (id: string) => {
      setActiveId(id);
      setView('chat');
    },
    [setActiveId, setView],
  );
  useEffect(() => {
    setLaunchHandler(open);
    return () => setLaunchHandler(null);
  }, [open, setLaunchHandler]);

  // 原生层据此决定"正在看这个对话"时不发通知
  useEffect(() => {
    void MinibotRemote.setActiveThread({ threadId: view === 'chat' ? activeId : null });
  }, [view, activeId]);

  const pending = approvals.filter((a) => a.result === undefined);
  const waiting = new Set(pending.map((a) => a.threadId));
  const newThread = async (): Promise<void> => {
    try {
      const thread = await api.createThread(bot.id);
      await refreshThreads();
      open(thread.id);
    } catch (err) {
      setFailure(errorText(err));
    }
  };

  return (
    <>
      <ApprovalBar count={pending.length} onOpen={() => pending[0] !== undefined && open(pending[0].threadId)} />
      {view === 'list' ? (
        <ThreadListScreen
          bot={bot}
          bots={bots}
          threads={threads}
          running={running}
          waiting={waiting}
          onSelectBot={onSelectBot}
          onOpen={open}
          onNew={() => void newThread()}
          onRename={setRenaming}
          onDelete={setDeleting}
          onSettings={onSettings}
        />
      ) : (
        <ConversationScreen
          api={api}
          events={events}
          bot={bot}
          conv={conv}
          failure={failure}
          onFailure={setFailure}
          onBack={() => history.back()}
          onRename={setRenaming}
          onDelete={setDeleting}
        />
      )}
      <ThreadDialogs
        api={api}
        renaming={renaming}
        deleting={deleting}
        onCloseRename={() => setRenaming(null)}
        onCloseDelete={() => setDeleting(null)}
        refreshThreads={refreshThreads}
        onDeleted={(id, remaining) => {
          if (activeRef.current === id) {
            setActiveId(remaining[0]?.id ?? null);
            if (view === 'chat') history.back();
          }
        }}
        onError={setFailure}
      />
    </>
  );
}

export function MobileApp() {
  const status = usePhoneStatus();
  const [boot, setBoot] = useState<Boot | null>(null);
  // 已发现的新版本（点“稍后”后仍保留，设置页里可以再装）与是否弹出更新对话框
  const [update, setUpdate] = useState<{ version: string; notes: string } | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const dismissedVersion = useRef<string | null>(null);
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);
  const [diagPrompt, setDiagPrompt] = useState(false);
  const [diagAvailable, setDiagAvailable] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const lastErrorAt = useRef(new Map<string, number>());
  const [view, setViewState] = useState<'list' | 'chat'>('list');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [guide, setGuide] = useState(false);
  const listeners = useRef(new Set<(event: KernelEvent) => void>());
  const launchHandler = useRef<((threadId: string) => void) | null>(null);
  const pendingLaunch = useRef<string | null>(null);
  const paired = status?.paired ?? false;

  // 启动和每次回到前台都自动查（原生层 6 小时内只真正请求一次），手动检查不受限。
  // 自动检查对点过“稍后”的同一版本不再弹窗，设置页里仍显示可更新
  const checkUpdate = useCallback(async (manual: boolean): Promise<void> => {
    try {
      const result = await MinibotRemote.checkUpdate({ manual });
      if (result.available && result.version !== undefined) {
        setUpdate({ version: result.version, notes: result.notes ?? '' });
        setUpdateNotice(null);
        if (manual || dismissedVersion.current !== result.version) setUpdateOpen(true);
      } else {
        setUpdate(null);
        if (manual) setUpdateNotice(t('about.updateNone'));
      }
    } catch {
      if (manual) setUpdateNotice(t('about.updateError'));
    }
  }, []);
  useEffect(() => {
    void checkUpdate(false);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void checkUpdate(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [checkUpdate]);

  // 首次打开且还没表态：显示与电脑端同样的说明
  useEffect(() => {
    void MinibotRemote.getDiagnostics().then(
      (info) => {
        setDiagAvailable(info.available);
        setDiagPrompt(info.available && info.consent === 'unset');
      },
      () => {
        setDiagAvailable(false);
        setDiagPrompt(false);
      },
    );
  }, []);

  // 网页层未捕获错误：同一 message 每分钟最多上报一次
  useEffect(() => {
    const report = (err: unknown, fallback: string): void => {
      const message = err instanceof Error ? err.message || fallback : typeof err === 'string' ? err : fallback;
      const now = Date.now();
      const last = lastErrorAt.current.get(message);
      if (last !== undefined && now - last < 60_000) return;
      lastErrorAt.current.set(message, now);
      if (lastErrorAt.current.size > 100) lastErrorAt.current.clear();
      void MinibotRemote.reportClientError({
        message,
        ...(err instanceof Error && typeof err.stack === 'string' ? { stack: err.stack } : {}),
      }).catch(() => {});
    };
    const onError = (event: ErrorEvent): void => report(event.error, event.message);
    const onRejection = (event: PromiseRejectionEvent): void => report(event.reason, 'unhandledrejection');
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  // 进入对话页压一层历史，安卓返回键回到列表
  const setView = useCallback((next: 'list' | 'chat') => {
    setViewState((current) => {
      if (next === 'chat' && current !== 'chat') history.pushState({ view: 'chat' }, '');
      return next;
    });
  }, []);
  // 设置页同样压一层历史：返回键先关设置页，再回到列表
  const settingsRef = useRef(false);
  const openSettings = useCallback(() => {
    if (settingsRef.current) return;
    settingsRef.current = true;
    history.pushState({ view: 'settings' }, '');
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => {
    if (settingsRef.current) history.back();
  }, []);
  useEffect(() => {
    const onPop = (): void => {
      if (settingsRef.current) {
        settingsRef.current = false;
        setSettingsOpen(false);
        setGuide(false);
        return;
      }
      setViewState('list');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // 取消配对 / 被撤销后回到配对页：设置页一并关掉
  useEffect(() => {
    if (!paired) closeSettings();
  }, [paired, closeSettings]);

  // 已配对后建立 API 与事件通道
  useEffect(() => {
    if (!paired) {
      setBoot(null);
      return;
    }
    const events = nativeEvents((event) => {
      for (const listener of listeners.current) listener(event);
    });
    const subscribe: Subscribe = (listener) => {
      listeners.current.add(listener);
      return () => listeners.current.delete(listener);
    };
    setBoot({ api: createApi(nativeTransport()), events, subscribe });
    return () => events.close();
  }, [paired]);

  // 通知点击：冷启动取一次存着的对话，已在运行时订阅 openThread
  const openThread = useCallback((threadId: string) => {
    if (launchHandler.current !== null) launchHandler.current(threadId);
    else pendingLaunch.current = threadId;
  }, []);
  useEffect(() => {
    void MinibotRemote.takeLaunchThread().then(({ threadId }) => threadId !== null && openThread(threadId));
    const handle = MinibotRemote.addListener('openThread', ({ threadId }) => openThread(threadId));
    return () => void handle.then((h) => h.remove());
  }, [openThread]);
  const setLaunchHandler = useCallback((handler: ((threadId: string) => void) | null) => {
    launchHandler.current = handler;
    if (handler !== null && pendingLaunch.current !== null) {
      const id = pendingLaunch.current;
      pendingLaunch.current = null;
      handler(id);
    }
  }, []);

  const overlays = (
    <>
      {diagPrompt && (
        <Dialog
          open
          onClose={() => setDiagPrompt(false)}
          title={t('diagnostics.prompt.title')}
          footer={
            <>
              <button
                type="button"
                className={PILL_SECONDARY}
                onClick={() => {
                  setDiagPrompt(false);
                  void MinibotRemote.setDiagnostics({ consent: 'off' }).catch(() => {});
                }}>
                {t('diagnostics.prompt.decline')}
              </button>
              <button
                type="button"
                className={PILL_PRIMARY}
                onClick={() => {
                  setDiagPrompt(false);
                  void MinibotRemote.setDiagnostics({ consent: 'on' }).catch(() => {});
                }}>
                {t('diagnostics.prompt.accept')}
              </button>
            </>
          }>
          <div className="flex flex-col gap-2 text-[13px] leading-[19px] text-ink-secondary">
            <p>{t('diagnostics.prompt.body')}</p>
            <p>{t('diagnostics.allowed')}</p>
            <p>{t('diagnostics.forbidden')}</p>
          </div>
        </Dialog>
      )}
      {update !== null && updateOpen && (
        <UpdatePrompt
          version={update.version}
          notes={update.notes}
          onClose={() => {
            dismissedVersion.current = update.version;
            setUpdateOpen(false);
          }}
        />
      )}
      {diagAvailable && (
        <FeedbackSheet
          open={feedbackOpen}
          onClose={() => setFeedbackOpen(false)}
          onSent={() => {
            setFeedbackOpen(false);
            setFeedbackSent(true);
          }}
        />
      )}
      {feedbackSent && (
        <Dialog
          open
          onClose={() => setFeedbackSent(false)}
          title={t('feedback.title')}
          footer={
            <button type="button" className={PILL_SECONDARY} onClick={() => setFeedbackSent(false)}>
              {t('mobile.settings.close')}
            </button>
          }>
          <p className="text-[14px] text-ink-secondary">{t('feedback.ok')}</p>
        </Dialog>
      )}
    </>
  );

  if (status === null) return <div className="h-full bg-app" />;
  if (!paired || status.connection === 'revoked') {
    return (
      <>
        <PairScreen
          deviceModel={status.deviceModel}
          revoked={status.connection === 'revoked'}
          onPaired={() => {
            setGuide(true);
            openSettings();
          }}
          onFeedback={diagAvailable ? () => setFeedbackOpen(true) : undefined}
        />
        {overlays}
      </>
    );
  }

  const down = status.connection !== 'lan' && status.connection !== 'relay';
  const compatNotice =
    status.compat === 'phone_outdated'
      ? t('phone.compat.phone_outdated')
      : status.compat === 'pc_outdated'
        ? t('phone.compat.pc_outdated')
        : null;
  return (
    <div className="safe-top flex h-full flex-col bg-app">
      {compatNotice !== null && (
        <div className="flex shrink-0 items-center gap-2 bg-warning/10 px-3 py-1.5 text-[12px] text-warning">
          <span className="min-w-0 flex-1">{compatNotice}</span>
          {status.compat === 'phone_outdated' && (
            <button
              type="button"
              className="shrink-0 rounded-full px-2 py-0.5 font-medium hover:bg-warning/15"
              onClick={() => void checkUpdate(true)}>
              {t('about.update')}
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={openSettings}
        className={cn(
          'flex h-7 shrink-0 items-center justify-center gap-1.5 text-[12px]',
          down ? 'bg-warning/10 text-warning' : 'bg-card text-ink-secondary',
        )}>
        {status.pcName !== null && <span className="truncate">{status.pcName}</span>}
        <span>· {viaText(status)}</span>
      </button>
      {/* 设置页盖在对话区上：对话区只隐藏不卸载，返回后列表与对话状态都还在 */}
      <div className={cn('flex min-h-0 flex-1 flex-col', settingsOpen && 'hidden')}>
        {boot !== null && (
          <Connected boot={boot} onSettings={openSettings} view={view} setView={setView} setLaunchHandler={setLaunchHandler} />
        )}
      </div>
      {settingsOpen && (
        <SettingsScreen
          status={status}
          guide={guide}
          availableVersion={update?.version ?? null}
          updateNotice={updateNotice}
          onCheckUpdate={() => void checkUpdate(true)}
          onInstallUpdate={() => setUpdateOpen(true)}
          onBack={closeSettings}
        />
      )}
      {overlays}
    </div>
  );
}
