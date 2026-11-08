import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths } from '../src/paths.ts';
import type { Provider } from '../src/config/types.ts';
import {
  loadConfig,
  newBot,
  effectiveWorkspace,
  migrate,
} from '../src/config/config.ts';
import {
  listPresets,
  knownModels,
  defaultContextWindow,
  allowedThinkingLevels,
} from '../src/config/presets.ts';

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minibot-config-'));
}

test('缺省配置', async () => {
  const root = await tmpRoot();
  assert.deepEqual(await loadConfig(dataPaths(root)), {
    schemaVersion: 1,
    providers: [],
    mainBotId: null,
    consolidationModel: null,
  });
});

test('bot 默认值', () => {
  const b = newBot('b1');
  assert.equal(b.contextWindow, 128000);
  assert.equal(b.maxOutputTokens, 128000);
  assert.equal(b.approvalMode, 'ask');
  assert.equal(b.thinkingLevel, null);
});

test('workspace 为 null 时用默认工作目录', async () => {
  const root = await tmpRoot();
  const p = dataPaths(root);
  const b = newBot('b1');
  assert.equal(effectiveWorkspace(p, b), p.defaultWorkspace('b1'));
});

test('预设与 spec §5.1 一致', () => {
  const by = Object.fromEntries(listPresets().map((p) => [p.id, p]));
  assert.equal(listPresets().length, 8);
  assert.deepEqual([by['deepseek']!.format, by['deepseek']!.baseUrl], [
    'chat_completions',
    'https://api.deepseek.com',
  ]);
  assert.deepEqual([by['volc-coding']!.format, by['volc-coding']!.baseUrl], [
    'responses',
    'https://ark.cn-beijing.volces.com/api/coding/v3',
  ]);
  assert.equal(by['volc-agent-anthropic']!.baseUrl, 'https://ark.cn-beijing.volces.com/api/plan');
  assert.equal(by['volc-coding-anthropic']!.baseUrl, 'https://ark.cn-beijing.volces.com/api/coding');
  assert.equal(by['custom-chat']!.baseUrl, '');
  assert.equal(by['deepseek']!.contextWindow, 1_000_000);
  for (const id of ['custom-chat', 'custom-responses', 'custom-anthropic']) {
    assert.equal(by[id]!.contextWindow, 128_000);
  }
  for (const id of ['volc-coding', 'volc-coding-anthropic', 'volc-agent', 'volc-agent-anthropic']) {
    assert.equal(by[id]!.contextWindow, 256_000);
  }
});

test('思考档位与 spec §5.1.1 一致', () => {
  const by = Object.fromEntries(listPresets().map((p) => [p.id, p]));
  assert.deepEqual(by['custom-chat']!.thinkingLevels, [
    'off',
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  assert.deepEqual(by['custom-responses']!.thinkingLevels, by['custom-chat']!.thinkingLevels);
  assert.deepEqual(by['custom-anthropic']!.thinkingLevels, [
    'off',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  assert.deepEqual(by['deepseek']!.thinkingLevels, ['off', 'low', 'high', 'max']);
  for (const id of ['volc-coding', 'volc-agent']) {
    assert.deepEqual(by[id]!.thinkingLevels, ['low', 'medium', 'high']);
  }
  for (const id of ['volc-coding-anthropic', 'volc-agent-anthropic']) {
    assert.deepEqual(by[id]!.thinkingLevels, []);
  }
});

test('allowedThinkingLevels：无预设时按格式给通用全集', () => {
  const chat = { id: 'p', name: 'v', format: 'chat_completions', baseUrl: '' } as Provider;
  const responses = { id: 'p', name: 'v', format: 'responses', baseUrl: '' } as Provider;
  const anthropic = { id: 'p', name: 'v', format: 'anthropic_messages', baseUrl: '' } as Provider;
  const all = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  assert.deepEqual(allowedThinkingLevels(chat, 'x'), all);
  assert.deepEqual(allowedThinkingLevels(responses, 'x'), all);
  assert.deepEqual(allowedThinkingLevels(anthropic, 'x'), [
    'off',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
});

test('allowedThinkingLevels：火山按模型给档位（spec §5.1.1 火山表）', () => {
  const volc = {
    id: 'p',
    name: 'v',
    format: 'responses',
    baseUrl: '',
    presetId: 'volc-coding',
  } as Provider;
  assert.deepEqual(allowedThinkingLevels(volc, 'doubao-seed-2.1-pro'), [
    'off',
    'low',
    'medium',
    'high',
  ]);
  assert.deepEqual(allowedThinkingLevels(volc, 'deepseek-v4-pro'), ['off', 'low', 'high', 'max']);
  assert.deepEqual(allowedThinkingLevels(volc, 'glm-5.3-flash'), ['low', 'high', 'max']);
  assert.deepEqual(allowedThinkingLevels(volc, 'kimi-k3.1-pro'), ['low', 'high', 'max']);
  assert.deepEqual(allowedThinkingLevels(volc, 'kimi-k3'), ['low', 'medium', 'high']);
  assert.deepEqual(allowedThinkingLevels(volc, 'ark-code-latest'), ['low', 'medium', 'high']);
  assert.deepEqual(
    allowedThinkingLevels({ ...volc, presetId: 'volc-coding-anthropic', format: 'anthropic_messages' }, 'doubao-seed-2.1-pro'),
    [],
  );
});

test('defaultContextWindow：命中已知模型表 → 表中值；未命中 → 预设值；无预设 → 128000', () => {
  const volc = {
    id: 'p',
    name: 'v',
    format: 'responses',
    baseUrl: '',
    presetId: 'volc-agent',
  } as Provider;
  assert.equal(defaultContextWindow(volc, 'doubao-seed-2.1-pro'), 1_024_000);
  assert.equal(defaultContextWindow(volc, 'DeepSeek-V4-Pro'), 1_024_000);
  assert.equal(defaultContextWindow(volc, 'doubao-seed-2.0-mini'), 256_000);
  assert.equal(defaultContextWindow(volc, 'ark-code-latest'), 256_000);
  assert.equal(defaultContextWindow({ ...volc, presetId: undefined }, 'x'), 128_000);
});

test('knownModels 返回火山模型表', () => {
  const models = knownModels('volc-agent');
  assert.equal(models.length, 14);
  assert.ok(models.some((m) => m.id === 'doubao-seed-2.1-pro'));
  const mini = models.find((m) => m.id === 'doubao-seed-2.0-mini');
  assert.equal(mini?.contextWindow, 256_000);
  assert.deepEqual(knownModels('deepseek'), []);
});

test('不认识的 schemaVersion 报错', () => {
  assert.throws(() => migrate({ schemaVersion: 99 }));
});
