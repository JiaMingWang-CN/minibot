// 记忆：开关 + 记忆主题列表（还有所有 bot 共用的“关于你”）。点一个主题进入编辑页：
// 改内容、保存，下面是修改历史，每一条都能撤销。

import { useEffect, useState } from 'react';
import type { RevisionSource } from '@minibot/core';
import { Brain, FileText, FolderOpen, User } from 'lucide-react';
import type { MemoryIndex } from '../api';
import { t, type MessageKey } from '../i18n';
import { errorText, formatTime } from '../ui/settings';
import { useMemoryFile } from '../settings/useMemoryFile';
import type { PanelContext } from './BotPanel';
import { Card, ColRow, LinkRow, NavRow, NoteRow, SwitchRow, panelInputCls, primaryButtonCls, rowCls } from './rows';

export function MemoryPage({ api, bot, patch, open }: PanelContext) {
  const [index, setIndex] = useState<MemoryIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .listMemory(bot.id)
      .then(setIndex)
      .catch((err: unknown) => setError(errorText(err)));
  }, [api, bot.id]);

  return (
    <>
      <p className="mx-1 -mt-2 text-[13px] leading-normal text-ink-secondary">{t('panel.memory.intro', { name: bot.name })}</p>
      <Card>
        <SwitchRow
          icon={Brain}
          title={t('panel.memory.enabled')}
          hint={t('panel.memory.enabledHint')}
          checked={bot.memoryEnabled}
          onChange={() => void patch({ memoryEnabled: !bot.memoryEnabled })}
        />
      </Card>
      <Card label={t('panel.memory.topicsLabel')}>
        {error !== null ? (
          <NoteRow tone="warn">{error}</NoteRow>
        ) : index === null ? (
          <NoteRow>{t('common.loading')}</NoteRow>
        ) : index.topics.length === 0 ? (
          <NoteRow>{t('panel.memory.empty')}</NoteRow>
        ) : (
          index.topics.map((topic) => (
            <NavRow
              key={topic.path}
              icon={FileText}
              title={topic.name}
              hint={topic.summary ?? undefined}
              onClick={() => open({ id: 'memoryFile', name: topic.name, path: topic.path })}
            />
          ))
        )}
      </Card>
      <Card label={t('panel.memory.shared')}>
        {index !== null && (
          <NavRow icon={User} title={t('settings.profile.title')} hint={t('settings.profile.hint')} onClick={() => open({ id: 'memoryFile', name: t('settings.profile.title'), path: index.user.path })} />
        )}
        <LinkRow icon={FolderOpen} onClick={() => void window.minibot.openMemoryDir(bot.id).catch(() => {})}>
          {t('main.openMemory')}
        </LinkRow>
      </Card>
    </>
  );
}

const SOURCE: Record<RevisionSource, MessageKey> = {
  chat: 'panel.memory.source.chat',
  consolidation: 'panel.memory.source.consolidation',
  manual_ui: 'panel.memory.source.manual_ui',
  revert: 'panel.memory.source.revert',
  external: 'panel.memory.source.external',
};

export function MemoryFilePage({ api, path }: PanelContext & { path: string }) {
  const file = useMemoryFile(api, path);
  return (
    <>
      <Card>
        <ColRow>
          <textarea
            value={file.draft}
            disabled={!file.loaded || file.busy}
            onChange={(e) => file.setDraft(e.target.value)}
            aria-label={t('panel.memory.content')}
            spellCheck={false}
            className={`${panelInputCls} min-h-[240px] resize-y leading-relaxed`}
          />
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-[12px]">
              {file.error !== null && <span className="text-danger">{file.error}</span>}
              {file.notice !== null && <span className="text-success">{file.notice}</span>}
            </span>
            <button type="button" className={primaryButtonCls} disabled={!file.dirty || file.busy} onClick={() => void file.save()}>
              {t('common.save')}
            </button>
          </div>
        </ColRow>
      </Card>
      <Card label={t('panel.memory.history')}>
        {file.revisions.length === 0 ? (
          <NoteRow>{t('panel.memory.noHistory')}</NoteRow>
        ) : (
          file.revisions.map((r) => (
            <div key={r.id} className={rowCls}>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-ink">{t(SOURCE[r.source])}</div>
                <div className="text-[12px] text-ink-tertiary">{formatTime(r.createdAt)}</div>
              </div>
              <button
                type="button"
                disabled={file.busy}
                onClick={() => void file.revert(r.id)}
                className="shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-ink-secondary hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50">
                {t('panel.memory.undo')}
              </button>
            </div>
          ))
        )}
      </Card>
    </>
  );
}
