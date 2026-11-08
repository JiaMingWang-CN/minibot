import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import path from 'node:path';
import { dataPaths, defaultDataRoot } from '../src/paths.ts';

test('dataPaths 按 spec §11 布局', () => {
  const p = dataPaths('/r');
  assert.equal(p.memoryDir('b1'), path.join('/r', 'bots', 'b1', 'memory'));
  assert.equal(p.defaultWorkspace('b1'), path.join('/r', 'workspaces', 'b1'));
  assert.equal(p.db, path.join('/r', 'minibot.db'));
  assert.equal(p.botDir('b1'), path.join('/r', 'bots', 'b1'));
  assert.equal(p.botJson('b1'), path.join('/r', 'bots', 'b1', 'bot.json'));
  assert.equal(p.config, path.join('/r', 'config.json'));
  assert.equal(p.secrets, path.join('/r', 'secrets.bin'));
  assert.equal(p.userMd, path.join('/r', 'user.md'));
  assert.equal(p.outputs, path.join('/r', 'outputs'));
  assert.equal(p.botsDir, path.join('/r', 'bots'));
});

test('defaultDataRoot 是 ~/.minibot', () => {
  assert.equal(defaultDataRoot(), path.join(homedir(), '.minibot'));
});
