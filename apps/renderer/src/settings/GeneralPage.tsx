// 通用：关于你（用户画像 user.md，所有 bot 共用）。

import { useEffect, useState } from 'react';
import type { Bot } from '@minibot/core';
import type { Api } from '../api';
import { t } from '../i18n';
import { BUTTON_PRIMARY, INPUT, SETTINGS_CARD, SettingsGroup, errorText } from '../ui/settings';
import { cn } from '../lib/cn';
import { useMemoryFile } from './useMemoryFile';

export function GeneralPage({ api, bot }: { api: Api; bot: Bot }) {
  const [path, setPath] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    api
      .listMemory(bot.id)
      .then((m) => setPath(m.user.path))
      .catch((err: unknown) => setLoadError(errorText(err)));
  }, [api, bot.id]);
  const file = useMemoryFile(api, path);

  return (
    <SettingsGroup label={t('settings.profile.title')} footnote={t('settings.profile.hint')}>
      <div className={cn(SETTINGS_CARD, 'flex flex-col gap-3 p-4')}>
        <textarea
          value={file.draft}
          disabled={!file.loaded || file.busy}
          onChange={(e) => file.setDraft(e.target.value)}
          placeholder={t('settings.profile.placeholder')}
          aria-label={t('settings.profile.title')}
          className={cn(INPUT, 'min-h-[180px] resize-y leading-relaxed')}
        />
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 text-[12px]">
            {(loadError ?? file.error) !== null && <span className="text-danger">{loadError ?? file.error}</span>}
            {file.notice !== null && <span className="text-ink-secondary">{file.notice}</span>}
          </span>
          <button type="button" className={BUTTON_PRIMARY} disabled={!file.dirty || file.busy} onClick={() => void file.save()}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </SettingsGroup>
  );
}
