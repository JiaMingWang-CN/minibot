import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot, KernelEvent, KernelState, Thread } from '@minibot/core';
import { Loader2 } from 'lucide-react';
import { createApi, type Api, type EventConnection } from '@renderer/api';
import { cn } from '@renderer/lib/cn';
import { t } from '@renderer/i18n';
import { useConversation } from '@renderer/main/useConversation';
import { ThreadDialogs } from '@renderer/main/ThreadDialogs';
import { PILL_SECONDARY } from '@renderer/ui/recipes';
import { ApprovalBar } from './ApprovalBar';
import { MinibotRemote } from './native';
import { PairScreen } from './screens/PairScreen';
import { ConversationScreen } from './screens/ConversationScreen';
import { SettingsSheet, viaText } from './screens/SettingsSheet';
import { ThreadListScreen } from './screens/ThreadListScreen';
import { nativeEvents, nativeTransport } from './transport';
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

function BotView({ api, events, subscribe, bot, bots, onSelectBot, view, setView, setLaunchHandler }: {
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
  const conv = useConversation({ api, events, subscribe, botId: bot.id, contextWindow: bot.contextWindow, withContext: false, onError: setFailure });
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
  const [view, setViewState] = useState<'list' | 'chat'>('list');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [guide, setGuide] = useState(false);
  const listeners = useRef(new Set<(event: KernelEvent) => void>());
  const launchHandler = useRef<((threadId: string) => void) | null>(null);
  const pendingLaunch = useRef<string | null>(null);
  const paired = status?.paired ?? false;

  // 进入对话页压一层历史，安卓返回键回到列表
  const setView = useCallback((next: 'list' | 'chat') => {
    setViewState((current) => {
      if (next === 'chat' && current !== 'chat') history.pushState({ view: 'chat' }, '');
      return next;
    });
  }, []);
  useEffect(() => {
    const onPop = (): void => setViewState('list');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

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

  if (status === null) return <div className="h-full bg-app" />;
  if (!paired || status.connection === 'revoked') {
    return (
      <PairScreen
        deviceModel={status.deviceModel}
        revoked={status.connection === 'revoked'}
        onPaired={() => {
          setGuide(true);
          setSettingsOpen(true);
        }}
      />
    );
  }

  const down = status.connection !== 'lan' && status.connection !== 'relay';
  return (
    <div className="safe-top flex h-full flex-col bg-app">
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        className={cn(
          'flex h-7 shrink-0 items-center justify-center gap-1.5 text-[12px]',
          down ? 'bg-warning/10 text-warning' : 'bg-card text-ink-secondary',
        )}>
        {status.pcName !== null && <span className="truncate">{status.pcName}</span>}
        <span>· {viaText(status)}</span>
      </button>
      <div className="flex min-h-0 flex-1 flex-col">
        {boot !== null && (
          <Connected boot={boot} onSettings={() => setSettingsOpen(true)} view={view} setView={setView} setLaunchHandler={setLaunchHandler} />
        )}
      </div>
      {settingsOpen && (
        <SettingsSheet
          status={status}
          guide={guide}
          onClose={() => {
            setSettingsOpen(false);
            setGuide(false);
          }}
        />
      )}
    </div>
  );
}
