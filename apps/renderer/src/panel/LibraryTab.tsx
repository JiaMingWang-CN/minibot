// 资料库标签：记忆与工作目录两行，点进去各是一页。

import { useEffect, useState } from 'react';
import { Brain, Folder } from 'lucide-react';
import { t } from '../i18n';
import type { PanelContext } from './BotPanel';
import { Card, NavRow } from './rows';

/** 长路径只留最后两段 */
export function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}

export function LibraryTab({ api, bot, open, memoryVersion }: PanelContext) {
  const [topics, setTopics] = useState<number | null>(null);
  useEffect(() => {
    api
      .listMemory(bot.id)
      .then((m) => setTopics(m.topics.length))
      .catch(() => setTopics(null));
  }, [api, bot.id, memoryVersion]);

  const memoryValue = !bot.memoryEnabled
    ? t('panel.memory.off')
    : topics === null
      ? undefined
      : topics === 0
        ? t('panel.memory.nothingYet')
        : t('panel.memory.topics', { count: topics });

  return (
    <Card>
      <NavRow icon={Brain} title={t('panel.page.memory')} value={memoryValue} onClick={() => open({ id: 'memory' })} />
      <NavRow
        icon={Folder}
        title={t('panel.page.folder')}
        value={bot.workspace === null ? t('panel.folder.default') : shortPath(bot.workspace)}
        onClick={() => open({ id: 'folder' })}
      />
    </Card>
  );
}
