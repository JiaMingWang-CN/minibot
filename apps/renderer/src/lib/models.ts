// 一个模型的实际参数：服务下用户自己维护的模型优先，其次预设里的已知模型，最后是预设/接口格式的默认值。
// 规则与内核 config/presets.ts 一致。

import type { KernelState, ThinkingLevel } from '@minibot/core';
import type { PresetWithModels } from '../api';

export type ProviderInfo = KernelState['providers'][number];

export const ALL_LEVELS: ThinkingLevel[] = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface ModelSpec {
  contextWindow: number;
  /** null：没有明确值，沿用 bot 现有的输出上限 */
  maxOutputTokens: number | null;
  vision: boolean;
  thinkingLevels: ThinkingLevel[];
}

export function specOf(provider: ProviderInfo | undefined, preset: PresetWithModels | undefined, model: string): ModelSpec {
  const lowered = model.toLowerCase();
  const custom = provider?.models?.find((m) => m.id.toLowerCase() === lowered);
  if (custom !== undefined) {
    return {
      contextWindow: custom.contextWindow,
      maxOutputTokens: custom.maxOutputTokens,
      vision: custom.vision,
      thinkingLevels: custom.thinkingLevels,
    };
  }
  const known = preset?.models.find((m) => m.id.toLowerCase() === lowered);
  let thinkingLevels: ThinkingLevel[];
  if (provider === undefined) thinkingLevels = [];
  else if (preset !== undefined) thinkingLevels = preset.thinkingLevels.length === 0 ? [] : (known?.thinkingLevels ?? preset.thinkingLevels);
  else thinkingLevels = provider.format === 'anthropic_messages' ? ALL_LEVELS.filter((l) => l !== 'none' && l !== 'minimal') : ALL_LEVELS;
  return {
    contextWindow: known?.contextWindow ?? preset?.contextWindow ?? 128_000,
    maxOutputTokens: null,
    vision: true,
    thinkingLevels,
  };
}
