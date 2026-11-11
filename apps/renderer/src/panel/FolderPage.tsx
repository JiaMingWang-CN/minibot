// 工作目录：bot 读写文件、执行命令的地方。留空用默认目录。

import { useState } from 'react';
import { t } from '../i18n';
import { errorText } from '../ui/settings';
import type { PanelContext } from './BotPanel';
import { Card, ColRow, NoteRow, buttonCls, panelInputCls, primaryButtonCls } from './rows';

export function FolderPage({ bot, patch, isRunning }: PanelContext) {
  const [draft, setDraft] = useState(bot.workspace ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const next = draft.trim() === '' ? null : draft.trim();

  const save = async (value: string | null): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await patch({ workspace: value });
      setDraft(value ?? '');
      setMessage({ ok: true, text: t('common.saved') });
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="mx-1 -mt-2 text-[13px] leading-normal text-ink-secondary">{t('panel.folder.intro', { name: bot.name })}</p>
      <Card>
        <ColRow>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('panel.folder.placeholder')}
            aria-label={t('panel.page.folder')}
            spellCheck={false}
            className={`${panelInputCls} font-mono`}
          />
          <div className="flex justify-end gap-2">
            {bot.workspace !== null && (
              <button type="button" className={buttonCls} disabled={busy || isRunning} onClick={() => void save(null)}>
                {t('panel.folder.reset')}
              </button>
            )}
            <button type="button" className={primaryButtonCls} disabled={busy || isRunning || next === bot.workspace} onClick={() => void save(next)}>
              {t('common.save')}
            </button>
          </div>
        </ColRow>
        {isRunning && <NoteRow>{t('panel.whileRunning')}</NoteRow>}
        {message !== null && <NoteRow tone={message.ok ? 'ok' : 'warn'}>{message.text}</NoteRow>}
      </Card>
    </>
  );
}
