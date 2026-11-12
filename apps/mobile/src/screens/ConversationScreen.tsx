import { useState } from 'react';
import type { Bot, Thread } from '@minibot/core';
import { ArrowDown, ChevronLeft, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react';
import { fileToBase64, type Api, type EventConnection } from '@renderer/api';
import { cn } from '@renderer/lib/cn';
import { t } from '@renderer/i18n';
import { ApprovalCard } from '@renderer/main/ApprovalCard';
import { Composer } from '@renderer/main/Composer';
import { MarkdownText, SystemLine, Transcript } from '@renderer/main/Transcript';
import { MAX_IMAGES, useComposerImages } from '@renderer/main/useComposerImages';
import type { useConversation } from '@renderer/main/useConversation';
import { Menu } from '@renderer/ui/Menu';
import { ICON_BUTTON, PILL_SECONDARY } from '@renderer/ui/recipes';

const STICK_DISTANCE = 80;
const LOAD_OLDER_DISTANCE = 200;

type Conversation = ReturnType<typeof useConversation>;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ConversationScreen({
  api,
  events,
  bot,
  conv,
  failure,
  onFailure,
  onBack,
  onRename,
  onDelete,
}: {
  api: Api;
  events: EventConnection;
  bot: Bot;
  conv: Conversation;
  failure: string | null;
  onFailure: (message: string | null) => void;
  onBack: () => void;
  onRename: (thread: Thread) => void;
  onDelete: (thread: Thread) => void;
}) {
  const { activeId, active, messages, isRunning, streaming, approvals, retryNote, steered, setSteered, stuck, setStuck, scroller, hasOlder, loadOlder } = conv;
  const [draft, setDraft] = useState('');
  // 手机端不做模型能力判断：不支持图片时电脑端会直接拒绝并返回原因
  const composer = useComposerImages({ visionOk: true, model: bot.model });

  const send = async (): Promise<void> => {
    if (activeId === null) return;
    const text = draft.trim();
    if (text.length === 0 && composer.images.length === 0) return;
    composer.setError(null);
    try {
      const payload = await Promise.all(composer.images.map(async (i) => ({ mediaType: i.file.type, data: await fileToBase64(i.file) })));
      const result = await api.sendMessage(activeId, text, payload);
      composer.clear();
      setDraft('');
      setStuck(true);
      if (result.mode === 'steer' && text.length > 0) setSteered((list) => [...list, text]);
    } catch (err) {
      composer.setError(errorText(err));
    }
  };

  const lastMessage = messages[messages.length - 1];
  const canRetry = !isRunning && lastMessage !== undefined && lastMessage.kind === 'notice';
  const showStreaming = streaming !== null && (streaming.text.length > 0 || streaming.reasoning.length > 0);
  const empty = messages.length === 0 && !showStreaming;
  const activeApprovals = approvals.filter((a) => a.threadId === activeId);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app">
      <header className="flex h-12 shrink-0 items-center gap-1 px-2">
        <button type="button" aria-label={t('mobile.chat.back')} className={ICON_BUTTON} onClick={onBack}>
          <ChevronLeft size={20} aria-hidden />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-medium">{active?.title ?? t('main.noThread')}</h1>
        {active !== null && (
          <Menu
            align="end"
            width={160}
            items={[
              { label: t('mobile.threads.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: () => onRename(active) },
              { label: t('mobile.threads.delete'), icon: <Trash2 size={14} aria-hidden />, danger: true, onSelect: () => onDelete(active) },
            ]}
            trigger={(props) => (
              <button type="button" aria-label={t('mobile.chat.more')} className={ICON_BUTTON} {...props}>
                <MoreHorizontal size={18} aria-hidden />
              </button>
            )}
          />
        )}
      </header>

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < STICK_DISTANCE);
          if (hasOlder && el.scrollTop < LOAD_OLDER_DISTANCE) void loadOlder();
        }}>
        <div role="log" aria-label={t('main.conversation', { name: bot.name })} className="flex min-h-full flex-col gap-5 py-4">
          {failure !== null && (
            <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger">
              <span className="min-w-0 flex-1 break-words">{failure}</span>
              <button type="button" aria-label={t('main.dismiss')} onClick={() => onFailure(null)} className="shrink-0 opacity-70">
                <X size={14} aria-hidden />
              </button>
            </div>
          )}
          {empty ? (
            <div className="m-auto flex flex-col items-center gap-2 text-center">
              <h2 className="text-[20px] tracking-[-0.01em]">{t('main.emptyTitle', { name: bot.name })}</h2>
              <p className="max-w-[300px] text-[13px] leading-[18px] text-ink-secondary">{t('main.emptyBody')}</p>
            </div>
          ) : (
            <>
              <Transcript
                api={api}
                messages={messages}
                running={isRunning}
                noticeAction={
                  canRetry ? (
                    <button
                      type="button"
                      className={cn(PILL_SECONDARY, 'h-7 px-3 text-[13px]')}
                      onClick={() => activeId !== null && void api.retry(activeId).catch((err: unknown) => onFailure(errorText(err)))}>
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

      <footer className="safe-bottom relative shrink-0 px-3 pb-3">
        {!stuck && !empty && (
          <button
            type="button"
            aria-label={t('main.jumpToLatest')}
            onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })}
            className={cn(ICON_BUTTON, 'absolute -top-11 left-1/2 -translate-x-1/2 bg-composer shadow-float ring-[0.5px] ring-ink/10')}>
            <ArrowDown size={16} aria-hidden />
          </button>
        )}
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={() => void send()}
          onStop={() => activeId !== null && events.send({ type: 'abort', threadId: activeId })}
          running={isRunning}
          disabled={activeId === null}
          placeholder={isRunning ? t('main.placeholderRunning') : t('main.placeholder', { name: bot.name })}
          images={composer.images}
          canAddImage={composer.images.length < MAX_IMAGES}
          onAddImages={composer.add}
          onRemoveImage={composer.remove}
          error={composer.error}
          above={activeApprovals.map((request) => (
            <ApprovalCard
              key={request.id}
              request={request}
              source={`${bot.name} · ${active?.title ?? ''}`}
              result={request.result}
              onRespond={(approve, always) => events.send({ type: 'approval', id: request.id, approve, always })}
            />
          ))}
        />
      </footer>
    </div>
  );
}
