// 详情标签：模型一行；本对话（用量、压缩上下文、审批记录）；设置入口。

import { Archive, Coins, ScrollText, Settings, Sparkles } from 'lucide-react';
import { cn } from '../lib/cn';
import { t } from '../i18n';
import { ModelPicker } from '../main/ModelPicker';
import { formatTokens } from '../main/ContextRing';
import type { PanelContext } from './BotPanel';
import { Card, CardLabel, NavRow, RowIcon, RowText, rowCls } from './rows';

export function DetailsTab({ bot, providers, presets, patch, usage, isRunning, threadId, onCompact, onOpenSettings, open }: PanelContext) {
  const usageValue =
    usage === null || usage.calls === 0
      ? t('panel.usage.none')
      : t('panel.usage.value', { input: formatTokens(usage.inputTokens), output: formatTokens(usage.outputTokens) });
  return (
    <div>
      <section className="pt-2">
        <div className={cn(rowCls, 'rounded-[8px]')}>
          <RowIcon icon={Sparkles} />
          <RowText title={t('panel.model')} />
          <ModelPicker bot={bot} providers={providers} presets={presets} isDisabled={isRunning} onChange={(p) => void patch(p)} />
        </div>
      </section>

      <section>
        <CardLabel>{t('panel.section.conversation')}</CardLabel>
        <div className={rowCls}>
          <RowIcon icon={Coins} />
          <RowText title={t('panel.usage')} />
          <span className="shrink-0 text-[13px] text-ink-secondary tabular-nums">{usageValue}</span>
        </div>
        <NavRow icon={Archive} title={t('main.compact')} hint={t('panel.compactHint')} drill={false} disabled={isRunning || threadId === null} onClick={onCompact} />
        <NavRow icon={ScrollText} title={t('settings.page.activity')} onClick={() => onOpenSettings('activity')} />
      </section>

      <Card label={t('panel.page.settings')}>
        <NavRow icon={Settings} title={t('panel.page.settings')} hint={t('panel.settingsHint')} onClick={() => open({ id: 'settings' })} />
      </Card>
    </div>
  );
}
