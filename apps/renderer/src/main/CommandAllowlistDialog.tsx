// 命令白名单：列出这个 bot 不经询问就能执行的命令，可以删，也可以手动加一条。

import { useId, useState } from 'react';
import type { Bot } from '@minibot/core';
import { Loader2, Trash2 } from 'lucide-react';
import type { BotPatch } from '../api';
import { t } from '../i18n';
import { Dialog } from '../ui/Dialog';
import { FIELD, PILL_PRIMARY, PILL_SECONDARY } from '../ui/recipes';
import { errorText } from '../ui/settings';

export function CommandAllowlistDialog({ bot, patch, onClose }: { bot: Bot; patch: (patch: BotPatch) => Promise<void>; onClose: () => void }) {
  const [command, setCommand] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const exactId = useId();

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

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('allowlist.title')}
      wide
      footer={
        <button type="button" onClick={onClose} className={PILL_SECONDARY}>
          {t('allowlist.close')}
        </button>
      }>
      <div className="flex max-h-[60dvh] flex-col gap-3 overflow-y-auto">
        <p className="text-[12px] text-ink-secondary">{t('allowlist.forBot', { name: bot.name })}</p>
        <p className="text-[12px] leading-relaxed text-ink-secondary">{t('allowlist.scope')}</p>
        {error !== null && (
          <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}
        {bot.allowedCommands.length > 0 ? (
          <ul className="divide-y-[0.5px] divide-hairline rounded-xl border-[0.5px] border-hairline">
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
          <p className="rounded-xl bg-inset px-3 py-4 text-[13px] text-ink-secondary">{t('allowlist.empty')}</p>
        )}
        <form
          className="border-t-[0.5px] border-hairline pt-4"
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
              className={`${FIELD} mt-1.5 resize-y font-mono text-[12px]`}
            />
          </label>
          <p id={exactId} className="mt-1 text-[11px] leading-relaxed text-ink-secondary">
            {t('allowlist.exact')}
          </p>
          <div className="mt-4 flex justify-end">
            <button type="submit" disabled={saving !== null || command.trim() === ''} className={PILL_PRIMARY}>
              {t(saving === 'add' ? 'allowlist.adding' : 'allowlist.add')}
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
