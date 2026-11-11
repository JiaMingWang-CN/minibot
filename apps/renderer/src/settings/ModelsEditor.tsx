// 服务下的模型列表：平时只显示每个模型的名称与参数摘要，右侧是测试连接、编辑、删除三个图标按钮；
// 点编辑才展开名称、上下文窗口、最大输出、图像识别、推理档位。
// 编辑中的数字用字符串保存，点“保存”时才校验并转成数字。

import { useState } from 'react';
import type { CustomModel, ThinkingLevel } from '@minibot/core';
import { Check, Loader2, Pencil, PlugZap, Plus, Trash2 } from 'lucide-react';
import type { PresetWithModels } from '../api';
import { cn } from '../lib/cn';
import { t, type MessageKey } from '../i18n';
import { ICON_BUTTON_SM } from '../ui/recipes';
import { BUTTON, Field, INPUT, Switch } from '../ui/settings';

export interface ModelDraft {
  id: string;
  contextWindow: string;
  maxOutputTokens: string;
  vision: boolean;
  thinkingLevels: ThinkingLevel[];
}

export function toDrafts(models: CustomModel[]): ModelDraft[] {
  return models.map((m) => ({
    id: m.id,
    contextWindow: String(m.contextWindow),
    maxOutputTokens: String(m.maxOutputTokens),
    vision: m.vision,
    thinkingLevels: [...m.thinkingLevels],
  }));
}

/** 编辑器的初始内容：服务已有自己的模型列表就用它，否则把预设里的模型全部列出来 */
export function initialDrafts(provider: { models?: CustomModel[] } | null, preset: PresetWithModels | undefined): ModelDraft[] {
  if (provider?.models !== undefined) return toDrafts(provider.models);
  if (preset === undefined) return [];
  return preset.models.map((m) => ({
    id: m.id,
    contextWindow: String(m.contextWindow),
    maxOutputTokens: String(Math.min(128_000, m.contextWindow)),
    vision: true,
    thinkingLevels: [...(m.thinkingLevels ?? preset.thinkingLevels)],
  }));
}

function positive(text: string): number | null {
  const n = Number(text.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 校验并转成可保存的模型；不合格时抛出说明问题并指导怎么改的中文错误 */
export function fromDrafts(drafts: ModelDraft[]): CustomModel[] {
  const seen = new Set<string>();
  return drafts.map((d, index) => {
    const id = d.id.trim();
    if (id === '') throw new Error(t('settings.models.noName', { n: index + 1 }));
    const contextWindow = positive(d.contextWindow);
    if (contextWindow === null) throw new Error(t('settings.models.badContext', { name: id }));
    const maxOutputTokens = positive(d.maxOutputTokens);
    if (maxOutputTokens === null) throw new Error(t('settings.models.badMaxOutput', { name: id }));
    if (maxOutputTokens > contextWindow) throw new Error(t('settings.models.outputTooBig', { name: id }));
    if (seen.has(id.toLowerCase())) throw new Error(t('settings.models.duplicate', { name: id }));
    seen.add(id.toLowerCase());
    return { id, contextWindow, maxOutputTokens, vision: d.vision, thinkingLevels: d.thinkingLevels };
  });
}

function compact(text: string): string {
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n <= 0) return text.trim();
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

function summaryOf(d: ModelDraft): string {
  const parts = [t('settings.models.sumContext', { n: compact(d.contextWindow) }), t('settings.models.sumOutput', { n: compact(d.maxOutputTokens) })];
  if (d.vision) parts.push(t('settings.models.sumVision'));
  if (d.thinkingLevels.length > 0) {
    parts.push(t('settings.models.sumThinking', { levels: d.thinkingLevels.map((l) => t(`thinking.${l}` as MessageKey)).join('/') }));
  }
  return parts.join(' · ');
}

export function ModelsEditor({
  drafts,
  onChange,
  levels,
  defaultContextWindow,
  onTest,
  testingId,
  disabled,
}: {
  drafts: ModelDraft[];
  onChange: (next: ModelDraft[]) => void;
  /** 这个服务的接口格式允许的推理档位 */
  levels: ThinkingLevel[];
  defaultContextWindow: number;
  /** 不传表示不能测试（服务还没保存） */
  onTest?: (modelId: string) => void;
  /** 正在测试的模型名 */
  testingId: string | null;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const patch = (index: number, change: Partial<ModelDraft>): void =>
    onChange(drafts.map((d, i) => (i === index ? { ...d, ...change } : d)));
  const toggleLevel = (index: number, level: ThinkingLevel): void => {
    const d = drafts[index]!;
    const has = d.thinkingLevels.includes(level);
    patch(index, { thinkingLevels: levels.filter((l) => (l === level ? !has : d.thinkingLevels.includes(l))) });
  };
  const remove = (index: number): void => {
    onChange(drafts.filter((_, j) => j !== index));
    setEditing((e) => (e === null || e === index ? null : e > index ? e - 1 : e));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="text-[12px] text-ink-secondary">{t('settings.models.title')}</span>
        <span className="flex-1" />
        <button
          type="button"
          className={BUTTON}
          onClick={() => {
            onChange([
              ...drafts,
              { id: '', contextWindow: String(defaultContextWindow), maxOutputTokens: '32000', vision: false, thinkingLevels: [] },
            ]);
            setEditing(drafts.length);
          }}>
          <Plus size={14} aria-hidden />
          {t('settings.models.add')}
        </button>
      </div>
      {drafts.length === 0 && <p className="text-[12px] leading-4 text-ink-tertiary">{t('settings.models.empty')}</p>}
      {drafts.map((d, i) => {
        const open = editing === i;
        const name = d.id.trim();
        return (
          <div key={i} className="flex flex-col gap-3 rounded-[10px] border-[0.5px] border-edge px-3 py-2">
            <div className="flex items-center gap-1">
              <span className="mr-1 flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={cn('truncate font-mono text-[13px] leading-5', name === '' ? 'text-ink-tertiary' : 'text-ink')}>
                  {name === '' ? t('settings.models.unnamed') : name}
                </span>
                <span className="truncate text-[12px] leading-4 text-ink-tertiary">{summaryOf(d)}</span>
              </span>
              {onTest !== undefined && (
                <button
                  type="button"
                  aria-label={t('settings.models.test')}
                  title={t('settings.models.test')}
                  disabled={disabled || name === ''}
                  onClick={() => onTest(name)}
                  className={ICON_BUTTON_SM}>
                  {testingId === name ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <PlugZap size={15} aria-hidden />}
                </button>
              )}
              <button
                type="button"
                aria-label={open ? t('settings.models.done') : t('settings.models.edit')}
                title={open ? t('settings.models.done') : t('settings.models.edit')}
                aria-pressed={open}
                onClick={() => setEditing(open ? null : i)}
                className={cn(ICON_BUTTON_SM, open && 'bg-ink/[0.08] text-ink')}>
                {open ? <Check size={15} aria-hidden /> : <Pencil size={15} aria-hidden />}
              </button>
              <button type="button" aria-label={t('settings.models.remove')} title={t('settings.models.remove')} onClick={() => remove(i)} className={ICON_BUTTON_SM}>
                <Trash2 size={15} aria-hidden />
              </button>
            </div>
            {open && (
              <div className="flex flex-col gap-3 border-t-[0.5px] border-edge pt-3 pb-1">
                <Field label={t('settings.models.name')}>
                  <input value={d.id} onChange={(e) => patch(i, { id: e.target.value })} spellCheck={false} className={cn(INPUT, 'font-mono')} />
                </Field>
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
                          className={cn('h-7 rounded-full px-3 text-[12px] transition-colors', on ? 'bg-ink text-on-ink' : 'bg-ink/5 text-ink-secondary hover:bg-ink/10')}>
                          {t(`thinking.${level}` as MessageKey)}
                        </button>
                      );
                    })}
                  </span>
                  {d.thinkingLevels.length === 0 && <span className="text-[12px] text-ink-tertiary">{t('settings.models.thinkingNone')}</span>}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
