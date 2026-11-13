// 对话记录：用户消息是右侧的灰色气泡；模型回复不加气泡，直接排版 Markdown，
// 思考过程和工具调用折叠在回复里；摘要与提示是居中的系统行。

import { memo, useEffect, useState, type ReactNode } from 'react';
import type { Block, StoredMessage } from '@minibot/core';
import { Check, ChevronRight, CircleSlash, Loader2, X } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Api } from '../api';
import { cn } from '../lib/cn';
import { t, type MessageKey } from '../i18n';

type ToolUse = Extract<Block, { type: 'tool_use' }>;
type ToolResult = Extract<Block, { type: 'tool_result' }>;

export function textOf(blocks: Block[]): string {
  return blocks
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

const TOOL_LABEL: Record<string, MessageKey> = {
  read_file: 'tool.read_file',
  write_file: 'tool.write_file',
  edit_file: 'tool.edit_file',
  glob: 'tool.glob',
  grep: 'tool.grep',
  run_command: 'tool.run_command',
};

/** 工具调用在一行里显示的参数：路径、模式或命令 */
function toolArgument(input: Record<string, unknown>): string {
  for (const key of ['command', 'path', 'pattern']) {
    const value = input[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

// memo：流式输出时每个 delta 都会让整个对话重新渲染，没变的消息不能重新解析 Markdown
export const MarkdownText = memo(function MarkdownText({ children, streaming = false }: { children: string; streaming?: boolean }) {
  return (
    <div className={cn('markdown', streaming && 'after:ml-0.5 after:inline-block after:h-4 after:w-[2px] after:translate-y-0.5 after:animate-pulse after:bg-ink')}>
      <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
    </div>
  );
});

function Disclosure({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-[13px] text-ink-secondary transition-colors hover:text-ink">
        <ChevronRight size={14} className={cn('shrink-0 transition-transform', open && 'rotate-90')} aria-hidden />
        {summary}
      </button>
      {open && <div className="mt-1.5 ml-5 animate-fade-in">{children}</div>}
    </div>
  );
}

const ToolCall = memo(function ToolCall({ use, result, running }: { use: ToolUse; result: ToolResult | undefined; running: boolean }) {
  const label = TOOL_LABEL[use.name];
  const status =
    result === undefined ? (
      running ? <Loader2 size={13} className="shrink-0 animate-spin" aria-label={t('main.running')} /> : null
    ) : result.status === 'ok' ? (
      <Check size={13} className="shrink-0 text-success" aria-label={t('tool.status.ok')} />
    ) : result.status === 'error' ? (
      <X size={13} className="shrink-0 text-danger" aria-label={t('tool.status.error')} />
    ) : (
      <CircleSlash size={13} className="shrink-0 text-ink-tertiary" aria-label={t(`tool.status.${result.status}`)} />
    );
  return (
    <Disclosure
      summary={
        <>
          <span className="shrink-0 font-medium text-ink">{label !== undefined ? t(label) : use.name}</span>
          <span className="min-w-0 truncate font-mono text-[12px]">{toolArgument(use.input)}</span>
          {status}
        </>
      }>
      <pre className="max-h-80 overflow-auto rounded-lg bg-inset px-3 py-2 font-mono text-[12px] leading-[18px] whitespace-pre-wrap text-ink-secondary">
        {JSON.stringify(use.input, null, 2)}
        {result !== undefined && `\n\n${result.content}`}
      </pre>
    </Disclosure>
  );
});

function Attachment({ api, id }: { api: Api; id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let current: string | null = null;
    let alive = true;
    void api
      .attachmentUrl(id)
      .then((u) => {
        if (alive) setUrl((current = u));
        else URL.revokeObjectURL(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (current !== null) URL.revokeObjectURL(current);
    };
  }, [api, id]);
  return url === null ? (
    <span className="size-24 rounded-xl bg-inset" />
  ) : (
    <img src={url} alt="" className="max-h-48 max-w-64 rounded-xl object-cover" />
  );
}

export function SystemLine({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div role="status" className="flex animate-msg-in flex-wrap items-center justify-center gap-2 px-6 text-center text-[13px] text-ink-tertiary">
      <span>{children}</span>
      {action}
    </div>
  );
}

export function Transcript({
  api,
  messages,
  running,
  noticeAction,
}: {
  api: Api;
  messages: StoredMessage[];
  running: boolean;
  /** 最后一条是提示（如调用失败）时显示在它旁边的操作 */
  noticeAction?: ReactNode;
}) {
  // 工具结果在后续的 user 消息里，按 id 找回来配对
  const results = new Map<string, ToolResult>();
  for (const m of messages) for (const b of m.blocks) if (b.type === 'tool_result') results.set(b.toolUseId, b);
  const lastId = messages[messages.length - 1]?.id;

  return messages.map((m) => {
    if (m.kind === 'summary') {
      return (
        <div key={m.id} className="flex justify-center">
          <Disclosure summary={t('main.summary')}>
            <MarkdownText>{textOf(m.blocks)}</MarkdownText>
          </Disclosure>
        </div>
      );
    }
    if (m.kind === 'notice') {
      return (
        <SystemLine key={m.id} action={m.id === lastId ? noticeAction : undefined}>
          {textOf(m.blocks)}
        </SystemLine>
      );
    }
    if (m.role === 'user') {
      const text = textOf(m.blocks);
      const images = m.blocks.filter((b) => b.type === 'image');
      const skills = m.blocks.filter((b): b is Extract<Block, { type: 'skill' }> => b.type === 'skill');
      // 只装工具结果的 user 消息不单独显示
      if (text.length === 0 && images.length === 0 && skills.length === 0) return null;
      return (
        <div key={m.id} className="flex animate-msg-in flex-col items-end gap-2">
          {skills.length > 0 && (
            <div className="flex flex-col items-end gap-1">
              {skills.map((b, i) => (
                <Disclosure key={`skill-${i}`} summary={t('skills.loaded', { name: b.name })}>
                  <pre className="max-h-80 max-w-[min(36rem,85%)] overflow-auto rounded-lg bg-inset px-3 py-2 font-mono text-[12px] leading-[18px] whitespace-pre-wrap text-ink-secondary">
                    {b.text}
                  </pre>
                </Disclosure>
              ))}
            </div>
          )}
          {images.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2">
              {images.map((b) => b.type === 'image' && <Attachment key={b.id} api={api} id={b.id} />)}
            </div>
          )}
          {text.length > 0 && (
            <div className="max-w-[min(36rem,85%)] rounded-[20px] bg-raised px-4 py-2.5 text-[15px] leading-[1.55] break-words whitespace-pre-wrap">
              {text}
            </div>
          )}
        </div>
      );
    }
    return (
      <div key={m.id} className="flex animate-msg-in flex-col gap-2">
        {m.blocks.map((b, i) => {
          if (b.type === 'reasoning' && b.text.trim().length > 0) {
            return (
              <Disclosure key={i} summary={t('main.thinking')}>
                <p className="border-l-2 border-hairline pl-3 text-[13px] leading-5 whitespace-pre-wrap text-ink-secondary">{b.text}</p>
              </Disclosure>
            );
          }
          if (b.type === 'text' && b.text.length > 0) return <MarkdownText key={i}>{b.text}</MarkdownText>;
          if (b.type === 'tool_use') return <ToolCall key={i} use={b} result={results.get(b.id)} running={running} />;
          return null;
        })}
        {m.interrupted && <span className="text-[12px] text-ink-tertiary">{t('main.interrupted')}</span>}
      </div>
    );
  });
}
