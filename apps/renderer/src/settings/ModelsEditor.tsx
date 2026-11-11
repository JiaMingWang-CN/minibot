// 服务下的模型列表：每个模型有名称、上下文窗口、最大输出、是否支持图像识别、支持的推理档位。
// 编辑中的数字用字符串保存，点“保存”时才校验并转成数字。

import type { CustomModel, ThinkingLevel } from '@minibot/core';
import { Plus, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { t, type MessageKey } from '../i18n';
import { BUTTON, Field, INPUT, Switch } from '../ui/settings';

export interface ModelDraft {
  id: string;
  contextWindow: string;
  maxOutputTokens: string;
  vision: boolean;
  thinkingLevels: ThinkingLevel[];
}

export function toDrafts(models: CustomModel[] | undefined): ModelDraft[] {
  return (models ?? []).map((m) => ({
    id: m.id,
    contextWindow: String(m.contextWindow),
    maxOutputTokens: String(m.maxOutputTokens),
    vision: m.vision,
    thinkingLevels: [...m.thinkingLevels],
  }));
}

function positive(text: string): number | null {
  const n = Number(text.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 校验并转成可保存的模型；不合格时抛出带中文提示的错误 */
export function fromDrafts(drafts: ModelDraft[]): CustomModel[] {
  const seen = new Set<string>();
  return drafts.map((d) => {
    const id = d.id.trim();
    const contextWindow = positive(d.contextWindow);
    const maxOutputTokens = positive(d.maxOutputTokens);
    if (id === '' || contextWindow === null || maxOutputTokens === null) throw new Error(t('settings.models.invalid', { name: id }));
    if (seen.has(id.toLowerCase())) throw new Error(t('settings.models.duplicate', { name: id }));
    seen.add(id.toLowerCase());
    return { id, contextWindow, maxOutputTokens, vision: d.vision, thinkingLevels: d.thinkingLevels };
  });
}

export function ModelsEditor({
  drafts,
  onChange,
  levels,
  defaultContextWindow,
}: {
  drafts: ModelDraft[];
  onChange: (next: ModelDraft[]) => void;
  /** 这个服务的接口格式允许的推理档位 */
  levels: ThinkingLevel[];
  defaultContextWindow: number;
}) {
  const patch = (index: number, change: Partial<ModelDraft>): void =>
    onChange(drafts.map((d, i) => (i === index ? { ...d, ...change } : d)));
  const toggleLevel = (index: number, level: ThinkingLevel): void => {
    const d = drafts[index]!;
    const has = d.thinkingLevels.includes(level);
    patch(index, { thinkingLevels: levels.filter((l) => (l === level ? !has : d.thinkingLevels.includes(l))) });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="text-[12px] text-ink-secondary">{t('settings.models.title')}</span>
        <span className="flex-1" />
        <button
          type="button"
          className={BUTTON}
          onClick={() =>
            onChange([
              ...drafts,
              { id: '', contextWindow: String(defaultContextWindow), maxOutputTokens: '32000', vision: false, thinkingLevels: [] },
            ])
          }>
          <Plus size={14} aria-hidden />
          {t('settings.models.add')}
        </button>
      </div>
      <p className="text-[12px] leading-4 text-ink-tertiary">{drafts.length === 0 ? t('settings.models.empty') : t('settings.models.hint')}</p>
      {drafts.map((d, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-[10px] border-[0.5px] border-edge p-3">
          <div className="flex items-end gap-2">
            <Field label={t('settings.models.name')}>
              <input value={d.id} onChange={(e) => patch(i, { id: e.target.value })} spellCheck={false} className={cn(INPUT, 'font-mono')} />
            </Field>
            <button
              type="button"
              aria-label={t('settings.models.remove')}
              title={t('settings.models.remove')}
              onClick={() => onChange(drafts.filter((_, j) => j !== i))}
              className="mb-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-ink-tertiary hover:text-ink">
              <X size={14} aria-hidden />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('settings.models.context')}>
              <input value={d.contextWindow} onChange={(e) => patch(i, { contextWindow: e.target.value })} inputMode="numeric" className={cn(INPUT, 'font-mono')} />
            </Field>
            <Field label={t('settings.models.maxOutput')}>
              <input value={d.maxOutputTokens} onChange={(e) => patch(i, { maxOutputTokens: e.target.value })} inputMode="numeric" className={cn(INPUT, 'font-mono')} />
            </Field>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex-1 text-[13px] text-ink">{t('settings.models.vision')}</span>
            <Switch checked={d.vision} aria-label={t('settings.models.vision')} onClick={() => patch(i, { vision: !d.vision })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-ink-secondary">{t('settings.models.thinking')}</span>
            <span className="flex flex-wrap gap-1.5">
              {levels.map((level) => {
                const on = d.thinkingLevels.includes(level);
                return (
                  <button
                    key={level}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleLevel(i, level)}
                    className={cn(
                      'h-7 rounded-full px-3 text-[12px] transition-colors',
                      on ? 'bg-ink text-on-ink' : 'bg-ink/5 text-ink-secondary hover:bg-ink/10',
                    )}>
                    {t(`thinking.${level}` as MessageKey)}
                  </button>
                );
              })}
            </span>
            {d.thinkingLevels.length === 0 && <span className="text-[12px] text-ink-tertiary">{t('settings.models.thinkingNone')}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
