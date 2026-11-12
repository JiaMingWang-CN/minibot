import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths } from '../src/paths.ts';
import { RemoteStore } from '../src/remote/store.ts';
import { generateKeyPair } from '../src/remote/noise.ts';
import { fakeCrypto } from './kernel-harness.ts';
import type { KeyCrypto } from '../src/secrets/store.ts';

async function tmp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-rs-'));
  return { root, paths: dataPaths(root) };
}

const basicText: KeyCrypto = { ...fakeCrypto(), backend: () => 'basic_text' };

test('store 首次生成', async () => {
  const { paths } = await tmp();
  const a = await RemoteStore.open({ paths, crypto: fakeCrypto() });
  assert.equal(a.available(), true);
  const pub = a.identity().publicKey.toString('hex');
  assert.match(a.routeId(), /^[0-9a-f]{32}$/);
  const b = await RemoteStore.open({ paths, crypto: fakeCrypto() });
  assert.equal(b.identity().publicKey.toString('hex'), pub);
  assert.equal(b.routeId(), a.routeId());
});

test('store 不可用', async () => {
  const { root, paths } = await tmp();
  const s = await RemoteStore.open({ paths, crypto: basicText, platform: 'linux' });
  assert.equal(s.available(), false);
  assert.throws(() => s.identity());
  assert.deepEqual(await fs.readdir(root), []);
});

test('store 无法解密', async () => {
  const { paths } = await tmp();
  await fs.writeFile(paths.remoteKey, Buffer.from('损坏的内容'));
  const s = await RemoteStore.open({ paths, crypto: fakeCrypto() });
  assert.equal(s.available(), false);
  assert.equal((await fs.readFile(paths.remoteKey)).toString('utf8'), '损坏的内容');
});

test('store 私钥不落明文', async () => {
  const { paths } = await tmp();
  const s = await RemoteStore.open({ paths, crypto: fakeCrypto() });
  await s.updateConfig({ relayToken: 'relay-secret-token-123456' });
  await s.addDevice('手机', generateKeyPair().publicKey);
  const priv = s.identity().privateKey;
  for (const file of [paths.remoteJson, paths.remoteKey, paths.devicesJson]) {
    const text = (await fs.readFile(file)).toString('latin1');
    assert.ok(!text.includes(priv.toString('base64url')), file);
    assert.ok(!text.includes(priv.toString('hex')), file);
    assert.ok(!text.includes('relay-secret-token-123456'), file);
  }
});

test('store 设备增删', async () => {
  const { paths } = await tmp();
  const s = await RemoteStore.open({ paths, crypto: fakeCrypto() });
  const d1 = await s.addDevice('甲', generateKeyPair().publicKey);
  const d2 = await s.addDevice('  乙  ', generateKeyPair().publicKey);
  assert.equal(d2.name, '乙');
  assert.equal(await s.removeDevice(d1.id), true);
  assert.equal(await s.removeDevice('nope'), false);
  const again = await RemoteStore.open({ paths, crypto: fakeCrypto() });
  assert.deepEqual(again.devices().map((d) => d.id), [d2.id]);
  assert.equal(again.findDevice(d1.id), null);
});

test('store 配置校验', async () => {
  const { paths } = await tmp();
  const s = await RemoteStore.open({ paths, crypto: fakeCrypto() });
  assert.deepEqual(
    { relayUrl: s.config().relayUrl, lanEnabled: s.config().lanEnabled, lanPort: s.config().lanPort },
    { relayUrl: null, lanEnabled: true, lanPort: 47821 },
  );
  await assert.rejects(s.updateConfig({ relayUrl: 'http://x' }), /中继地址必须以 ws:\/\/ 或 wss:\/\/ 开头/);
  await assert.rejects(s.updateConfig({ lanPort: 80 }), /端口必须是 1024 到 65535 之间的整数/);
  await s.updateConfig({ relayUrl: 'wss://r.example.com/v1', lanPort: 50000, pcName: '我的电脑' });
  const again = await RemoteStore.open({ paths, crypto: fakeCrypto() });
  assert.equal(again.config().relayUrl, 'wss://r.example.com/v1');
  assert.equal(again.config().lanPort, 50000);
});

test('store touch 节流落盘', async () => {
  const { paths } = await tmp();
  let t = 1_000;
  const s = await RemoteStore.open({ paths, crypto: fakeCrypto(), now: () => t });
  const d = await s.addDevice('甲', generateKeyPair().publicKey);
  await s.touch(d.id, 'lan');
  t += 10_000;
  await s.touch(d.id, 'relay');
  assert.equal(s.findDevice(d.id)!.lastVia, 'relay');
  const onDisk = JSON.parse(await fs.readFile(paths.devicesJson, 'utf8')) as { lastVia: string }[];
  assert.equal(onDisk[0]!.lastVia, 'lan');
  t += 61_000;
  await s.touch(d.id, 'relay');
  const later = JSON.parse(await fs.readFile(paths.devicesJson, 'utf8')) as { lastVia: string }[];
  assert.equal(later[0]!.lastVia, 'relay');
});

test('store 首次保存密钥失败：不抛出，手机功能不可用', async () => {
  const { paths } = await tmp();
  const failing: KeyCrypto = {
    ...fakeCrypto(),
    encrypt: () => {
      throw new Error('safeStorage 不可用');
    },
  };
  const s = await RemoteStore.open({ paths, crypto: failing });
  assert.equal(s.available(), false);
  assert.throws(() => s.identity());
});
