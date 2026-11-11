import presetsData from './presets.json' with { type: 'json' };
import { THINKING_LEVELS } from './types.ts';
import type { CustomModel, KnownModel, Preset, Provider, ThinkingLevel } from './types.ts';

interface PresetsFile {
  presets: Preset[];
  modelSets: Record<string, KnownModel[]>;
}

const data = presetsData as unknown as PresetsFile;

function findPreset(id: string): Preset | undefined {
  return data.presets.find((p) => p.id === id);
}

function copyPreset(p: Preset): Preset {
  return { ...p, thinkingLevels: [...p.thinkingLevels] };
}

export function listPresets(): Preset[] {
  return data.presets.map(copyPreset);
}

export function knownModels(presetId: string): KnownModel[] {
  const preset = findPreset(presetId);
  if (preset?.modelSet === undefined) return [];
  const set = data.modelSets[preset.modelSet];
  if (set === undefined) return [];
  return set.map((m) => {
    const copy: KnownModel = { id: m.id, contextWindow: m.contextWindow };
    if (m.thinkingLevels !== undefined) copy.thinkingLevels = [...m.thinkingLevels];
    return copy;
  });
}

function findKnownModel(preset: Preset, model?: string): KnownModel | undefined {
  if (model === undefined || preset.modelSet === undefined) return undefined;
  const set = data.modelSets[preset.modelSet];
  if (set === undefined) return undefined;
  const lowered = model.toLowerCase();
  return set.find((m) => m.id.toLowerCase() === lowered);
}

export function findCustomModel(provider: Provider, model?: string): CustomModel | undefined {
  if (model === undefined) return undefined;
  const lowered = model.toLowerCase();
  return provider.models?.find((m) => m.id.toLowerCase() === lowered);
}

export function defaultContextWindow(provider: Provider, model?: string): number {
  const custom = findCustomModel(provider, model);
  if (custom !== undefined) return custom.contextWindow;
  const preset = provider.presetId === undefined ? undefined : findPreset(provider.presetId);
  if (preset === undefined) return 128_000;
  const known = findKnownModel(preset, model);
  return known?.contextWindow ?? preset.contextWindow;
}

export function allowedThinkingLevels(provider: Provider, model?: string): ThinkingLevel[] {
  const custom = findCustomModel(provider, model);
  if (custom !== undefined) return [...custom.thinkingLevels];
  const preset = provider.presetId === undefined ? undefined : findPreset(provider.presetId);
  if (preset !== undefined) {
    if (preset.thinkingLevels.length === 0) return [];
    const known = findKnownModel(preset, model);
    if (known?.thinkingLevels !== undefined) return [...known.thinkingLevels];
    return [...preset.thinkingLevels];
  }
  return provider.format === 'anthropic_messages'
    ? ['off', 'low', 'medium', 'high', 'xhigh', 'max']
    : [...THINKING_LEVELS];
}
