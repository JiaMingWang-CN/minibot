import { promises as fs } from 'node:fs';
import { atomicWriteFile } from '../fs/atomic-write.ts';
import type { DataPaths } from '../paths.ts';
import type { AppConfig, Bot, Provider } from './types.ts';
import { APPROVAL_MODES, THINKING_LEVELS } from './types.ts';

import personasData from './default-personas.json' with { type: 'json' };

const personaData = personasData as unknown as {
  personas: { name: string; persona: string }[];
};

export function defaultConfig(): AppConfig {
  return { schemaVersion: 1, providers: [], mainBotId: null, consolidationModel: null };
}

export function newBot(id: string, providerId = '', model = ''): Bot {
  return {
    schemaVersion: 1,
    id,
    name: '',
    persona: '',
    providerId,
    model,
    contextWindow: 128_000,
    maxOutputTokens: 128_000,
    workspace: null,
    approvalMode: 'ask',
    thinkingLevel: null,
    allowedCommands: [],
    memoryEnabled: true,
  };
}

export function effectiveWorkspace(p: DataPaths, b: Bot): string {
  return b.workspace ?? p.defaultWorkspace(b.id);
}

export async function loadConfig(p: DataPaths): Promise<AppConfig> {
  let text: string;
  try {
    text = await fs.readFile(p.config, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig();
    throw err;
  }
  const migrated = migrate(JSON.parse(text));
  if (!('providers' in migrated)) throw new Error('config.json 不是应用配置');
  return migrated;
}

export async function saveConfig(p: DataPaths, c: AppConfig): Promise<void> {
  await atomicWriteFile(p.config, `${JSON.stringify(c, null, 2)}\n`);
}

export async function loadBot(p: DataPaths, id: string): Promise<Bot> {
  const text = await fs.readFile(p.botJson(id), 'utf8');
  const migrated = migrate(JSON.parse(text));
  if (!('id' in migrated) || 'providers' in migrated) throw new Error(`${p.botJson(id)} 不是 bot 配置`);
  return migrated;
}

export async function saveBot(p: DataPaths, b: Bot): Promise<void> {
  await atomicWriteFile(p.botJson(b.id), `${JSON.stringify(b, null, 2)}\n`);
}

export async function listBots(p: DataPaths): Promise<Bot[]> {
  let entries;
  try {
    entries = await fs.readdir(p.botsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const ids = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const bots: Bot[] = [];
  for (const id of ids) {
    const bot = await loadBot(p, id);
    bots.push(bot);
  }
  return bots;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function isThinkingLevel(v: unknown): boolean {
  return typeof v === 'string' && (THINKING_LEVELS as readonly string[]).includes(v);
}

function migrateProvider(raw: unknown, index: number): Provider {
  if (!isRecord(raw)) throw new Error(`providers[${index}] 不是对象`);
  const { id, name, format, baseUrl } = raw;
  if (typeof id !== 'string' || typeof name !== 'string') {
    throw new Error(`providers[${index}] 缺少 id 或 name`);
  }
  if (format !== 'chat_completions' && format !== 'responses' && format !== 'anthropic_messages') {
    throw new Error(`providers[${index}] 的 format 无效`);
  }
  if (typeof baseUrl !== 'string') throw new Error(`providers[${index}] 缺少 baseUrl`);
  const provider: Provider = { id, name, format, baseUrl };
  if (typeof raw['apiKeyEnv'] === 'string') provider.apiKeyEnv = raw['apiKeyEnv'];
  if (typeof raw['presetId'] === 'string') provider.presetId = raw['presetId'];
  return provider;
}

export function migrate(raw: unknown): AppConfig | Bot {
  if (!isRecord(raw)) throw new Error('配置内容不是对象');
  if (raw['schemaVersion'] !== 1) {
    throw new Error(`不支持的 schemaVersion：${String(raw['schemaVersion'])}`);
  }
  if (Array.isArray(raw['providers'])) {
    const providers = raw['providers'].map((item, index) => migrateProvider(item, index));
    const mainBotId = asString(raw['mainBotId']);
    let consolidationModel: AppConfig['consolidationModel'] = null;
    const cm = raw['consolidationModel'];
    if (isRecord(cm) && typeof cm['providerId'] === 'string' && typeof cm['model'] === 'string') {
      consolidationModel = { providerId: cm['providerId'], model: cm['model'] };
    }
    return {
      schemaVersion: 1,
      providers,
      mainBotId: mainBotId === null || mainBotId.length === 0 ? null : mainBotId,
      consolidationModel,
    };
  }
  if (typeof raw['id'] === 'string') {
    const id = raw['id'];
    const name = asString(raw['name']) ?? '';
    const persona = asString(raw['persona']) ?? '';
    const providerId = asString(raw['providerId']) ?? '';
    const model = asString(raw['model']) ?? '';
    const contextWindow =
      typeof raw['contextWindow'] === 'number' && raw['contextWindow'] > 0
        ? raw['contextWindow']
        : 128_000;
    const maxOutputTokens =
      typeof raw['maxOutputTokens'] === 'number' && raw['maxOutputTokens'] > 0
        ? raw['maxOutputTokens']
        : 128_000;
    const workspace = asString(raw['workspace']);
    return {
      schemaVersion: 1,
      id,
      name,
      persona,
      providerId,
      model,
      contextWindow,
      maxOutputTokens,
      workspace: workspace === null || workspace.length === 0 ? null : workspace,
      approvalMode: (APPROVAL_MODES as readonly unknown[]).includes(raw['approvalMode'])
        ? (raw['approvalMode'] as Bot['approvalMode'])
        : 'ask',
      thinkingLevel: isThinkingLevel(raw['thinkingLevel'])
        ? (raw['thinkingLevel'] as Bot['thinkingLevel'])
        : null,
      allowedCommands: Array.isArray(raw['allowedCommands'])
        ? raw['allowedCommands'].filter((c): c is string => typeof c === 'string')
        : [],
      memoryEnabled: raw['memoryEnabled'] !== false,
    };
  }
  throw new Error('无法识别的配置结构');
}

export function randomPersona(): { name: string; persona: string } {
  const list = personaData.personas;
  const index = Math.floor(Math.random() * list.length);
  const picked = list[index] ?? { name: '小满', persona: '你是一位温和、耐心的助理。' };
  return { name: picked.name, persona: picked.persona };
}
