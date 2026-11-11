import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { allowedThinkingLevels, defaultContextWindow } from '../src/config/presets.ts';
import { Kernel } from '../src/kernel.ts';
import { fakeCrypto, kernelHarness } from './kernel-harness.ts';

const model = {
  id: 'My-Model',
  contextWindow: 200_000,
  maxOutputTokens: 16_000,
  vision: true,
  thinkingLevels: ['off', 'high'] as const,
};

test('服务的模型列表保存后重开仍在，并覆盖上下文与推理档位', async () => {
  const h = await kernelHarness();
  try {
    const provider = (await h.kernel.state()).providers[0]!;
    await h.kernel.updateProvider(provider.id, { models: [{ ...model, thinkingLevels: [...model.thinkingLevels] }] });
    await h.close();

    const reopened = await Kernel.open({ dataRoot: h.root, crypto: fakeCrypto() });
    try {
      const saved = (await reopened.state()).providers[0]!;
      assert.equal(saved.models?.[0]?.id, 'My-Model');
      assert.equal(defaultContextWindow(saved, 'my-model'), 200_000);
      assert.deepEqual(allowedThinkingLevels(saved, 'MY-MODEL'), ['off', 'high']);
      assert.equal(defaultContextWindow(saved, 'other'), 128_000);
    } finally {
      await reopened.close();
    }
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('模型参数无效或重名时拒绝保存', async () => {
  const h = await kernelHarness();
  try {
    const provider = (await h.kernel.state()).providers[0]!;
    const ok = { ...model, thinkingLevels: [...model.thinkingLevels] };
    await assert.rejects(h.kernel.updateProvider(provider.id, { models: [{ ...ok, contextWindow: 0 }] }), /无效/);
    await assert.rejects(h.kernel.updateProvider(provider.id, { models: [{ ...ok, id: ' ' }] }), /无效/);
    await assert.rejects(h.kernel.updateProvider(provider.id, { models: [{ ...ok, vision: 'yes' as unknown as boolean }] }), /无效/);
    await assert.rejects(h.kernel.updateProvider(provider.id, { models: [ok, { ...ok, id: 'my-model' }] }), /重复/);
    await assert.rejects(
      h.kernel.updateProvider(provider.id, { models: [{ ...ok, thinkingLevels: ['ultra'] as never }] }),
      /无效/,
    );
    assert.equal((await h.kernel.state()).providers[0]?.models, undefined);
  } finally {
    await h.close();
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('config.json 里的坏模型项读盘时被跳过', async () => {
  const h = await kernelHarness();
  try {
    await h.close();
    const file = path.join(h.root, 'config.json');
    const config = JSON.parse(await fs.readFile(file, 'utf8'));
    config.providers[0].models = [{ id: 'bad' }, { ...model, thinkingLevels: [] }];
    await fs.writeFile(file, JSON.stringify(config));
    const reopened = await Kernel.open({ dataRoot: h.root, crypto: fakeCrypto() });
    try {
      const models = (await reopened.state()).providers[0]!.models;
      assert.deepEqual(models?.map((m) => m.id), ['My-Model']);
      assert.deepEqual(allowedThinkingLevels((await reopened.state()).providers[0]!, 'my-model'), []);
    } finally {
      await reopened.close();
    }
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});
