export type ApiFormat = 'chat_completions' | 'responses' | 'anthropic_messages';

export const THINKING_LEVELS = [
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface Provider {
  id: string;
  name: string;
  format: ApiFormat;
  baseUrl: string;
  apiKeyEnv?: string;
  presetId?: string;
}

export interface AppConfig {
  schemaVersion: 1;
  providers: Provider[];
  mainBotId: string | null;
  consolidationModel: { providerId: string; model: string } | null;
}

export interface Bot {
  schemaVersion: 1;
  id: string;
  name: string;
  persona: string;
  providerId: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  workspace: string | null;
  approvalMode: 'ask' | 'auto';
  thinkingLevel: ThinkingLevel | null;
}

export interface Preset {
  id: string;
  name: string;
  format: ApiFormat;
  baseUrl: string;
  note: string;
  contextWindow: number;
  modelSet?: string;
  thinkingLevels: ThinkingLevel[];
}

export interface KnownModel {
  id: string;
  contextWindow: number;
  thinkingLevels?: ThinkingLevel[];
}
