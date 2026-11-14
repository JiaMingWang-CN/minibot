// 主界面：外框顶栏（显示当前对话）→ 左侧 280px 侧栏 + 右侧对话区。
// 对话区：半透明的聊天头浮在消息上（左空 / 中间 bot / 右边上下文、模型、更多），
// 消息列最宽 48rem 居中，输入框胶囊在底部。

import { useCallback, useEffect, useState } from 'react';
import type { Bot, KernelState, SearchHit, SkillInfo, Thread } from '@minibot/core';
import { ArrowDown, ShieldAlert, X } from 'lucide-react';
import type { Subscribe } from '../App';
import { fileToBase64, type Api, type BotPatch, type EventConnection, type PresetWithModels } from '../api';
import { Logo } from '../brand/Logo';
import { FrameBar } from '../FrameBar';
import { cn } from '../lib/cn';
import { t } from '../i18n';
import { ICON_BUTTON, PILL_SECONDARY } from '../ui/recipes';
import { ApprovalCard } from './ApprovalCard';
import { ApprovalModePicker } from './ApprovalModePicker';
import { Composer } from './Composer';
import { ChatHeader } from './ChatHeader';
import { CommandAllowlistDialog } from './CommandAllowlistDialog';
import { BotPanel } from '../panel/BotPanel';
import { installUpdate, useUpdateState } from '../lib/updates';
import { DiagnosticsNotice } from '../settings/DiagnosticsNotice';
import { SettingsDialog, type SettingsPageId } from '../settings/SettingsDialog';
import { Sidebar } from './Sidebar';
import { ThreadDialogs } from './ThreadDialogs';
import { specOf } from '../lib/models';
import { MarkdownText, SystemLine, Transcript } from './Transcript';
import { useComposerImages, MAX_IMAGES } from './useComposerImages';
import { useConversation } from './useConversation';

/** 离底部这么近时算“跟随最新”，新内容会自动滚到底 */
const STICK_DISTANCE = 80;
const LOAD_OLDER_DISTANCE = 200;

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
  defaultWorkspaces,
  diagnosticsPrompt,
  onRefresh,
}: {
  defaultWorkspaces: Record<string, string>;
  /** 诊断同意状态还是 unset：显示一次提示条 */
  diagnosticsPrompt: boolean;
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
  const [draft, setDraft] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [renaming, setRenaming] = useState<Thread | null>(null);
  const [deleting, setDeleting] = useState<Thread | null>(null);
  const [failure, setFailure] = useState<string | null>(secretsUnreadable ? t('app.secretsUnreadable') : null);
  const [diagPrompt, setDiagPrompt] = useState(diagnosticsPrompt);
  const [skillList, setSkillList] = useState<SkillInfo[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const update = useUpdateState();
  const [updateDismissed, setUpdateDismissed] = useState(false);
  // 同意状态在别处（初始化、设置页）改过：不要再提示
  useEffect(() => {
    if (!diagnosticsPrompt) setDiagPrompt(false);
  }, [diagnosticsPrompt]);
  const currentProvider = providers.find((p) => p.id === bot.providerId);
  const visionOk = specOf(currentProvider, presets.find((x) => x.id === currentProvider?.presetId), bot.model).vision;
  const composer = useComposerImages({ visionOk, model: bot.model });
  const {
    threads,
    activeId,
    activeRef,
    setActiveId,
    active,
    messages,
    running,
    isRunning,
    streaming,
    approvals,
    memoryVersion,
    usage,
    context,
    retryNote,
    steered,
    setSteered,
    stuck,
    setStuck,
    scroller,
    hasOlder,
    loadOlder,
    refreshThreads,
  } = useConversation({ api, events, subscribe, botId: bot.id, contextWindow: bot.contextWindow, onError: setFailure });

  useEffect(() => {
    api.botSkills(bot.id).then((r) => setSkillList(r.skills), () => setSkillList([]));
  }, [api, bot.id]);

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

  const sendEvent = (message: Parameters<EventConnection['send']>[0]): void => {
    if (!events.send(message)) setFailure(t('main.eventsOffline'));
  };

  const send = async (): Promise<void> => {
    if (activeId === null) return;
    const text = draft.trim();
    if (text.length === 0 && composer.images.length === 0 && selectedSkills.length === 0) return;
    composer.setError(null);
    try {
      const payload = await Promise.all(composer.images.map(async (i) => ({ mediaType: i.file.type, data: await fileToBase64(i.file) })));
      const result = await api.sendMessage(activeId, text, payload, selectedSkills);
      composer.clear();
      setDraft('');
      setSelectedSkills([]);
      setStuck(true);
      if (result.mode === 'steer' && text.length > 0) setSteered((list) => [...list, text]);
    } catch (err) {
      composer.setError(errorText(err));
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

  const decideDiagnostics = (consent: 'on' | 'off'): void => {
    setDiagPrompt(false);
    api.setDiagnostics(consent).catch((err: unknown) => setFailure(errorText(err)));
  };

  const closeRename = useCallback(() => setRenaming(null), []);
  const closeDelete = useCallback(() => setDeleting(null), []);

  const activeApprovals = approvals.filter((a) => a.threadId === activeId);
  // 别的对话也在等批准：侧栏标出来，输入框上方给一个跳过去的入口
  const waitingElsewhere = approvals.filter((a) => a.result === undefined && a.threadId !== activeId);
  const waitingThreads = new Set(approvals.filter((a) => a.result === undefined).map((a) => a.threadId));
  const threadTitle = (id: string): string => threads.find((th) => th.id === id)?.title ?? '';
  const lastMessage = messages[messages.length - 1];
  const canRetry = !isRunning && lastMessage !== undefined && lastMessage.kind === 'notice';
  const showStreaming = streaming !== null && (streaming.text.length > 0 || streaming.reasoning.length > 0);
  const empty = messages.length === 0 && !showStreaming;
  // 接口不一定流式返回推理内容：开了思考档位时，等待期也显示“思考中”
  const thinkingOn = bot.thinkingLevel !== null && bot.thinkingLevel !== 'off' && bot.thinkingLevel !== 'none';

  return (
    <div className="flex h-full flex-col bg-frame">
      <FrameBar title={active?.title ?? t('main.noThread')} />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          bot={bot}
          threads={threads}
          activeId={activeId}
          running={running}
          waiting={waitingThreads}
          searchOpen={searchOpen}
          query={query}
          hits={hits}
          onSearchOpen={openSearch}
          onQuery={setQuery}
          onSelect={setActiveId}
          onNew={() => void newThread()}
          onRename={setRenaming}
          onDelete={setDeleting}
          onSettings={() => setSettingsPage('general')}
        />

        <main className="relative flex min-w-0 flex-1 flex-col bg-app">
          <ChatHeader
            bot={bot}
            providers={providers}
            presets={presets}
            active={active}
            isRunning={isRunning}
            context={context}
            usage={usage}
            panelOpen={panelOpen}
            onTogglePanel={() => setPanelOpen((o) => !o)}
            onOpenPanel={() => setPanelOpen(true)}
            onChangeModel={changeModel}
            onRename={setRenaming}
            onDelete={setDeleting}
            onCompact={compact}
          />

          <div
            ref={scroller}
            className="min-h-0 flex-1 overflow-y-auto px-5"
            onScroll={(e) => {
              const el = e.currentTarget;
              setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < STICK_DISTANCE);
              if (hasOlder && el.scrollTop < LOAD_OLDER_DISTANCE) void loadOlder();
            }}>
            <div role="log" aria-label={t('main.conversation', { name: bot.name })} className="chat-column flex min-h-full flex-col gap-5 pt-18 pb-6">
              {diagPrompt && <DiagnosticsNotice onDecide={decideDiagnostics} onDismiss={() => setDiagPrompt(false)} />}
              {(update.phase === 'ready' || update.phase === 'downloading') && !updateDismissed && (
                <div role="status" className="flex animate-pop-in flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-inset px-3.5 py-2.5 ring-[0.5px] ring-ink/10">
                  <span className="min-w-0 flex-1 text-[13px] text-ink">
                    {update.phase === 'ready'
                      ? t('update.ready', { version: update.version ?? '' })
                      : t('update.downloadingBanner', { version: update.version ?? '', percent: update.percent ?? 0 })}
                  </span>
                  {update.phase === 'ready' && running.size > 0 && (
                    <span className="text-[12px] text-ink-tertiary">{t('update.waitReply')}</span>
                  )}
                  {update.phase === 'ready' && (
                    <button
                      type="button"
                      className={`${PILL_SECONDARY} h-8 px-3.5 text-[13px]`}
                      disabled={running.size > 0}
                      onClick={() => void installUpdate().catch((err: unknown) => setFailure(errorText(err)))}>
                      {t('update.restart')}
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={t('update.dismiss')}
                    className="shrink-0 rounded-full p-1 text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink"
                    onClick={() => setUpdateDismissed(true)}>
                    <X size={14} aria-hidden />
                  </button>
                </div>
              )}
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
                    <span className="animate-pulse text-[13px] text-ink-tertiary">{thinkingOn ? t('main.thinkingNow') : t('main.waiting')}</span>
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
                onStop={() => activeId !== null && sendEvent({ type: 'abort', threadId: activeId })}
                running={isRunning}
                disabled={activeId === null}
                placeholder={isRunning ? t('main.placeholderRunning') : t('main.placeholder', { name: bot.name })}
                images={composer.images}
                canAddImage={visionOk && composer.images.length < MAX_IMAGES}
                onAddImages={composer.add}
                onRemoveImage={composer.remove}
                error={composer.error}
                skills={skillList}
                selectedSkills={selectedSkills}
                onPickSkill={(name) => setSelectedSkills((list) => (list.includes(name) ? list : [...list, name]))}
                onRemoveSkill={(name) => setSelectedSkills((list) => list.filter((x) => x !== name))}
                tools={
                  <ApprovalModePicker
                    mode={bot.approvalMode}
                    disabled={isRunning}
                    onChange={(approvalMode) => changeModel({ approvalMode })}
                    onManageAllowlist={() => setAllowlistOpen(true)}
                  />
                }
                above={
                  <>
                    {waitingElsewhere.length > 0 && (
                      <div role="status" className="flex items-center gap-2 rounded-full bg-warning/10 py-1.5 pr-1.5 pl-3.5 text-[13px] text-warning">
                        <ShieldAlert size={14} className="shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 truncate">
                          {t('approval.elsewhere', { count: waitingElsewhere.length, title: threadTitle(waitingElsewhere[0]!.threadId) })}
                        </span>
                        <button
                          type="button"
                          onClick={() => setActiveId(waitingElsewhere[0]!.threadId)}
                          className="shrink-0 rounded-full px-2.5 py-0.5 font-medium hover:bg-warning/10">
                          {t('approval.goThere')}
                        </button>
                      </div>
                    )}
                    {activeApprovals.map((request) => (
                      <ApprovalCard
                        key={request.id}
                        request={request}
                        source={`${bot.name} · ${threadTitle(request.threadId)}`}
                        result={request.result}
                        onRespond={(approve, always) => sendEvent({ type: 'approval', id: request.id, approve, always })}
                      />
                    ))}
                  </>
                }
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
            memoryVersion={memoryVersion}
            defaultWorkspace={defaultWorkspaces[bot.id]}
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
          memoryVersion={memoryVersion}
          subscribe={subscribe}
          onRefresh={onRefresh}
          onClose={closeSettings}
        />
      )}
      {allowlistOpen && <CommandAllowlistDialog bot={bot} patch={patchBot} onClose={() => setAllowlistOpen(false)} />}

      <ThreadDialogs
        api={api}
        renaming={renaming}
        deleting={deleting}
        onCloseRename={closeRename}
        onCloseDelete={closeDelete}
        refreshThreads={refreshThreads}
        onDeleted={(id, remaining) => {
          if (activeRef.current === id) setActiveId(remaining[0]?.id ?? null);
        }}
        onError={setFailure}
      />
    </div>
  );
}
