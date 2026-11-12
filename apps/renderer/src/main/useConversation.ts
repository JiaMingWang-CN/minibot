// 对话状态：对话列表、当前对话的消息与流式输出、运行状态、待审批、用量，
// 以及它们和内核事件、断线重连、往上翻页、跟随最新滚动之间的同步。界面只管把这些状态画出来。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ApprovalRequest, KernelEvent, StoredMessage, Thread, ThreadUsage } from '@minibot/core';
import type { Subscribe } from '../App';
import type { Api, EventConnection } from '../api';
import { t } from '../i18n';
import type { ApprovalResult } from './ApprovalCard';
import { textOf } from './Transcript';

/** 一次读多少条消息；离顶部这么近时再往前读一页 */
const PAGE_SIZE = 100;
/** 审批处理后卡片以“已处理”状态停留多久 */
const RESOLVED_LINGER_MS = 1800;

export interface Streaming {
  text: string;
  reasoning: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useConversation({
  api,
  events,
  subscribe,
  botId,
  contextWindow,
  withContext = true,
  onError,
}: {
  api: Api;
  events: EventConnection;
  subscribe: Subscribe;
  botId: string;
  contextWindow: number;
  /** 手机端的白名单不含上下文用量接口，传 false 就不去取 */
  withContext?: boolean;
  onError: (message: string) => void;
}) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  /** 待批准的请求；处理后带上 result，停留片刻再移除 */
  const [approvals, setApprovals] = useState<(ApprovalRequest & { result?: ApprovalResult })[]>([]);
  const [memoryVersion, setMemoryVersion] = useState(0);
  const [usage, setUsage] = useState<ThreadUsage | null>(null);
  const [context, setContext] = useState<{ tokens: number; window: number } | null>(null);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const [steered, setSteered] = useState<string[]>([]);
  const [stuck, setStuck] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const loadingOlder = useRef(false);
  /** 往前接了一页后，要保持的“离底部的距离” */
  const keepOffset = useRef<number | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  const active = threads.find((th) => th.id === activeId) ?? null;
  const isRunning = activeId !== null && running.has(activeId);

  const refreshThreads = useCallback(async (): Promise<Thread[]> => {
    const list = await api.listThreads(botId);
    setThreads(list);
    return list;
  }, [api, botId]);

  const refreshStats = useCallback(
    (threadId: string): void => {
      void api.usage(threadId).then((u) => activeRef.current === threadId && setUsage(u)).catch(() => {});
      if (withContext) {
        void api.context(threadId).then((c) => activeRef.current === threadId && setContext(c)).catch(() => {});
      }
    },
    [api, withContext],
  );

  // 首次进入：读对话列表（没有就建一个）与待审批
  useEffect(() => {
    void (async () => {
      try {
        let list = await refreshThreads();
        if (list.length === 0) {
          await api.createThread(botId);
          list = await refreshThreads();
        }
        setActiveId((current) => current ?? list[0]?.id ?? null);
        setApprovals(await api.pendingApprovals());
      } catch (err) {
        onError(errorText(err));
      }
    })();
  }, [api, botId, refreshThreads, onError]);

  // 切换对话：读消息与用量，回到底部
  useEffect(() => {
    setMessages([]);
    setStreaming(null);
    setUsage(null);
    setContext(null);
    setRetryNote(null);
    setSteered([]);
    setStuck(true);
    setHasOlder(false);
    if (activeId === null) return;
    let cancelled = false;
    api
      .listMessages(activeId, undefined, PAGE_SIZE)
      .then((list) => {
        if (cancelled) return;
        setMessages(list);
        setHasOlder(list.length === PAGE_SIZE);
      })
      .catch((err: unknown) => onError(errorText(err)));
    refreshStats(activeId);
    return () => {
      cancelled = true;
    };
  }, [api, activeId, refreshStats, onError]);

  // 连上（含断线重连、页面重载）后重新同步：运行状态、待审批，以及断开期间漏掉的消息
  useEffect(
    () =>
      events.onOpen(() => {
        void (async () => {
          try {
            const threadId = activeRef.current;
            const [runningIds, pending, latest] = await Promise.all([
              api.runningThreads(),
              api.pendingApprovals(),
              threadId === null ? Promise.resolve(null) : api.listMessages(threadId, undefined, PAGE_SIZE),
            ]);
            setRunning(new Set(runningIds));
            setApprovals(pending);
            if (latest !== null && activeRef.current === threadId) {
              const firstNew = latest[0]?.id ?? Infinity;
              setMessages((list) => [...list.filter((m) => m.id < firstNew), ...latest]);
              if (threadId !== null && !runningIds.includes(threadId)) setStreaming(null);
            }
          } catch {
            // 同步失败不打扰用户，下次重连会再试
          }
        })();
      }),
    [events, api],
  );

  // 往上翻：滚到顶附近时按最早一条消息的 id 再取一页，接在前面；保持正在看的位置不跳
  const loadOlder = async (): Promise<void> => {
    const threadId = activeRef.current;
    const first = messages[0];
    const el = scroller.current;
    if (threadId === null || first === undefined || el === null || loadingOlder.current) return;
    loadingOlder.current = true;
    try {
      const older = await api.listMessages(threadId, first.id, PAGE_SIZE);
      if (activeRef.current !== threadId) return;
      keepOffset.current = el.scrollHeight - el.scrollTop;
      setMessages((list) => [...older.filter((m) => m.id < (list[0]?.id ?? Infinity)), ...list]);
      setHasOlder(older.length === PAGE_SIZE);
    } catch (err) {
      onError(errorText(err));
    } finally {
      loadingOlder.current = false;
    }
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null || keepOffset.current === null) return;
    el.scrollTop = el.scrollHeight - keepOffset.current;
    keepOffset.current = null;
  }, [messages]);

  // 切换模型后上下文窗口跟着变，重新取一次占用
  useEffect(() => {
    if (activeRef.current !== null) refreshStats(activeRef.current);
  }, [contextWindow, refreshStats]);

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
          case 'approval_resolved': {
            const result = event.result as ApprovalResult;
            setApprovals((list) => list.map((a) => (a.id === event.id ? { ...a, result } : a)));
            setTimeout(() => setApprovals((list) => list.filter((a) => a.id !== event.id)), RESOLVED_LINGER_MS);
            return;
          }
          case 'memory_changed':
            setMemoryVersion((v) => v + 1);
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

  // 跟随最新：有新内容时滚到底
  useEffect(() => {
    const el = scroller.current;
    if (el !== null && stuck) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, approvals, retryNote, steered, stuck]);

  return {
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
    refreshStats,
  };
}
