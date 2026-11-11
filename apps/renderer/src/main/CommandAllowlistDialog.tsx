// 命令白名单：列出这个 bot 不经询问就能执行的命令，可以删，也可以手动加一条。
// 布局照 OpenMausBot 的 CommandAllowlistDialog；强调色换成本项目的墨色。

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Bot } from '@minibot/core';
import { Loader2, Trash2, X } from 'lucide-react';
import type { BotPatch } from '../api';
import { t } from '../i18n';
import { errorText } from '../ui/settings';

export function CommandAllowlistDialog({ bot, patch, onClose }: { bot: Bot; patch: (patch: BotPatch) => Promise<void>; onClose: () => void }) {
  const [command, setCommand] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const scopeId = useId();
  const exactId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected === true) opener.focus();
    };
  }, []);

  const save = async (next: string[], marker: string): Promise<boolean> => {
    if (saving !== null) return false;
    setSaving(marker);
    setError(null);
    try {
      await patch({ allowedCommands: next });
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setSaving(null);
    }
  };

  const add = async (): Promise<void> => {
    const value = command.trim();
    if (value === '') return;
    if (bot.allowedCommands.includes(value)) {
      setCommand('');
      return;
    }
    if (await save([...bot.allowedCommands, value], 'add')) setCommand('');
  };

  return createPortal(
    <div
      className="no-drag fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/55 p-4"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={scopeId}
        aria-busy={saving !== null || undefined}
        tabIndex={-1}
        className="flex max-h-[85dvh] w-full max-w-[520px] animate-pop-in flex-col overflow-hidden rounded-2xl border-[0.5px] border-hairline bg-panel shadow-menu outline-none">
        <div className="flex shrink-0 items-start justify-between gap-4 px-5 pt-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[16px] font-semibold text-ink">
              {t('allowlist.title')}
            </h2>
            <p className="mt-1 text-[12px] text-ink-secondary">{t('allowlist.forBot', { name: bot.name })}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('allowlist.close')}
            className="shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink">
            <X size={17} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          <p id={scopeId} className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
            {t('allowlist.scope')}
          </p>
          {error !== null && (
            <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
              {error}
            </div>
          )}
          {bot.allowedCommands.length > 0 ? (
            <ul className="mt-4 divide-y-[0.5px] divide-hairline rounded-xl border-[0.5px] border-hairline">
              {bot.allowedCommands.map((rule) => (
                <li key={rule} className="flex items-start gap-3 p-3">
                  <pre tabIndex={0} className="max-h-28 min-w-0 flex-1 overflow-auto font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-ink">
                    {rule}
                  </pre>
                  <button
                    type="button"
                    disabled={saving !== null}
                    onClick={() => void save(bot.allowedCommands.filter((c) => c !== rule), rule)}
                    aria-label={t('allowlist.removeAria', { command: rule })}
                    title={t(saving === rule ? 'allowlist.removing' : 'allowlist.remove')}
                    className="shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40">
                    {saving === rule ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Trash2 size={15} aria-hidden />}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 rounded-xl bg-inset px-3 py-4 text-[13px] text-ink-secondary">{t('allowlist.empty')}</p>
          )}
          <form
            className="mt-5 border-t-[0.5px] border-hairline pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}>
            <label className="block text-[12px] text-ink-secondary">
              {t('allowlist.command')}
              <textarea
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                disabled={saving !== null}
                required
                rows={2}
                spellCheck={false}
                aria-describedby={exactId}
                className="mt-1.5 w-full resize-y rounded-lg border-[0.5px] border-hairline bg-inset px-3 py-2 font-mono text-[12px] text-ink focus:border-ink/40 focus:outline-none disabled:opacity-50"
              />
            </label>
            <p id={exactId} className="mt-1 text-[11px] leading-relaxed text-ink-secondary">
              {t('allowlist.exact')}
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="submit"
                disabled={saving !== null || command.trim() === ''}
                className="rounded-lg bg-ink px-3.5 py-2 text-[13px] font-medium text-on-ink hover:bg-ink/85 disabled:opacity-40">
                {t(saving === 'add' ? 'allowlist.adding' : 'allowlist.add')}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>,
    document.body,
  );
}
