// 聊天头右侧的模型切换：按供应商分组列出预设模型（每组最后可以手填模型名），再加一组思考强度。
// 切换直接生效（改的是 bot 的设置，下一轮起使用），不弹确认。

import { useCallback, useState } from 'react';
import type { Bot, ThinkingLevel } from '@minibot/core';
import { ChevronDown } from 'lucide-react';
import type { PresetWithModels } from '../api';
import { cn } from '../lib/cn';
import { t, type MessageKey } from '../i18n';
import { specOf, type ProviderInfo } from '../lib/models';
import { Dialog } from '../ui/Dialog';
import { Menu, type MenuItem } from '../ui/Menu';
import { FIELD, PILL_PRIMARY, PILL_SECONDARY } from '../ui/recipes';

export type BotPatch = Partial<Pick<Bot, 'providerId' | 'model' | 'contextWindow' | 'maxOutputTokens' | 'thinkingLevel' | 'approvalMode'>>;

function levelLabel(level: ThinkingLevel | null): string {
  return t(level === null ? 'main.thinkingAuto' : (`thinking.${level}` as MessageKey));
}

export function ModelPicker({
  bot,
  providers,
  presets,
  isDisabled,
  onChange,
}: {
  bot: Bot;
  providers: ProviderInfo[];
  presets: PresetWithModels[];
  isDisabled: boolean;
  onChange: (patch: BotPatch) => void;
}) {
  const presetOf = (p: ProviderInfo | undefined) => presets.find((x) => x.id === p?.presetId);
  const current = providers.find((p) => p.id === bot.providerId);

  const [custom, setCustom] = useState<ProviderInfo | null>(null);
  const [customName, setCustomName] = useState('');
  const closeCustom = useCallback(() => setCustom(null), []);
  const patchFor = (provider: ProviderInfo, model: string): BotPatch => {
    const spec = specOf(provider, presetOf(provider), model);
    return {
      providerId: provider.id,
      model,
      contextWindow: spec.contextWindow,
      ...(spec.maxOutputTokens !== null ? { maxOutputTokens: spec.maxOutputTokens } : {}),
    };
  };
  const saveCustom = (): void => {
    const model = customName.trim();
    if (custom === null || model === '') return;
    onChange(patchFor(custom, model));
    setCustom(null);
  };

  const items: MenuItem[] = [];
  for (const provider of providers.filter((p) => p.hasKey || p.id === bot.providerId)) {
    const preset = presetOf(provider);
    const ids = [...new Set([...(provider.models ?? []).map((m) => m.id), ...(preset?.models ?? []).map((m) => m.id)])];
    if (provider.id === bot.providerId && !ids.includes(bot.model)) ids.unshift(bot.model);
    items.push({ type: 'label', label: provider.name });
    for (const id of ids) {
      const selected = provider.id === bot.providerId && id === bot.model;
      items.push({
        label: id,
        checked: selected,
        onSelect: () => {
          if (selected) return;
          onChange(patchFor(provider, id));
        },
      });
    }
    items.push({
      label: t('main.customModel'),
      onSelect: () => {
        setCustomName(provider.id === bot.providerId ? bot.model : '');
        setCustom(provider);
      },
    });
  }
  const levels = specOf(current, presetOf(current), bot.model).thinkingLevels;
  if (levels.length > 0) {
    items.push({ type: 'separator' }, { type: 'label', label: t('main.thinkingLevel') });
    for (const level of [null, ...levels]) {
      items.push({
        label: levelLabel(level),
        checked: bot.thinkingLevel === level,
        onSelect: () => bot.thinkingLevel !== level && onChange({ thinkingLevel: level }),
      });
    }
  }

  return (
    <>
    <Dialog
      open={custom !== null}
      onClose={closeCustom}
      title={t('main.customModelTitle', { provider: custom?.name ?? '' })}
      footer={
        <>
          <button type="button" className={PILL_SECONDARY} onClick={closeCustom}>
            {t('common.cancel')}
          </button>
          <button type="button" className={PILL_PRIMARY} disabled={customName.trim() === ''} onClick={saveCustom}>
            {t('common.save')}
          </button>
        </>
      }>
      <input
        value={customName}
        onChange={(e) => setCustomName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && saveCustom()}
        placeholder={t('onboarding.model.modelName')}
        aria-label={t('onboarding.model.modelName')}
        spellCheck={false}
        className={cn(FIELD, 'font-mono')}
      />
    </Dialog>
    <Menu
      items={items}
      align="end"
      width={260}
      trigger={(props) => (
        <button
          {...props}
          type="button"
          disabled={isDisabled}
          title={t('main.model')}
          className={cn(
            'inline-flex h-8 max-w-[240px] min-w-0 shrink items-center gap-1 rounded-full pr-2 pl-3 text-[13px] text-ink-secondary transition-colors',
            'hover:bg-ink/[0.06] hover:text-ink aria-expanded:bg-ink/[0.08] aria-expanded:text-ink disabled:opacity-40 disabled:hover:bg-transparent',
          )}>
          <span className="min-w-0 truncate">{bot.model}</span>
          {bot.thinkingLevel !== null && <span className="shrink-0 text-ink-tertiary">· {levelLabel(bot.thinkingLevel)}</span>}
          <ChevronDown size={13} className="shrink-0 text-ink-tertiary" aria-hidden />
        </button>
      )}
    />
    </>
  );
}
