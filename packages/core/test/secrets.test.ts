import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretSet, REDACTED } from '../src/secrets/redact.ts';
import { SecretStore, SecretPersistError, type KeyCrypto } from '../src/secrets/store.ts';

function fakeCrypto(backend: string): KeyCrypto {
  return {
    backend: () => backend,
    encrypt: (plain) => Buffer.concat([Buffer.from('enc:'), Buffer.from(Buffer.from(plain).toString('base64'))]),
    decrypt: (buf) => Buffer.from(buf.toString('utf8').slice(4), 'base64').toString('utf8'),
  };
}

async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-secrets-'));
  return path.join(dir, 'secrets.bin');
}

test('只收录长度 >= 8 的 Key，替换为占位符', () => {
  const s = new SecretSet();
  s.add('short');
  s.add('sk-12345678');
  assert.equal(s.redact('a sk-12345678 b short'), `a ${REDACTED} b short`);
  assert.equal(s.containsKnown('x sk-12345678'), true);
  assert.equal(s.containsKnown('x short'), false);
});

test('一个 Key 是另一个的前缀时，先替换长的', () => {
  const s = new SecretSet();
  s.add('abcdefgh');
  s.add('abcdefgh123');
  assert.equal(s.redact('abcdefgh123'), REDACTED);
  assert.equal(s.redact('x abcdefgh123 y'), `x ${REDACTED} y`);
});

test('secrets.bin 不含明文 Key', async () => {
  const f = await tmpFile();
  const secrets = new SecretSet();
  const st = new SecretStore(f, fakeCrypto('os'), secrets);
  await st.set('p1', 'sk-12345678');
  const bytes = await fs.readFile(f);
  assert.equal(bytes.includes(Buffer.from('sk-12345678')), false);
  assert.equal(secrets.containsKnown('sk-12345678'), true);
});

test('Linux basic_text 后端拒绝保存', async () => {
  const f = await tmpFile();
  const st = new SecretStore(f, fakeCrypto('basic_text'), new SecretSet(), { platform: 'linux' });
  assert.equal(st.canPersist(), false);
  await assert.rejects(st.set('p1', 'sk-12345678'), SecretPersistError);
});

test('环境变量里的 Key 可读、不落盘，且加入脱敏集合', async () => {
  const f = await tmpFile();
  const secrets = new SecretSet();
  const st = new SecretStore(f, fakeCrypto('os'), secrets, { env: { MY_KEY: 'sk-env-12345678' } });
  assert.equal(st.get('p1', 'MY_KEY'), 'sk-env-12345678');
  assert.equal(secrets.redact('x sk-env-12345678'), `x ${REDACTED}`);
  await assert.rejects(fs.readFile(f), (err: NodeJS.ErrnoException) => err.code === 'ENOENT');
});

test('load 后已存的 Key 加入脱敏集合', async () => {
  const f = await tmpFile();
  const first = new SecretStore(f, fakeCrypto('os'), new SecretSet());
  await first.set('p1', 'sk-12345678');
  const secrets = new SecretSet();
  const second = new SecretStore(f, fakeCrypto('os'), secrets);
  await second.load();
  assert.equal(secrets.redact('x sk-12345678'), `x ${REDACTED}`);
  assert.equal(second.get('p1'), 'sk-12345678');
});

test('delete 后 get 返回 null', async () => {
  const f = await tmpFile();
  const st = new SecretStore(f, fakeCrypto('os'), new SecretSet());
  await st.set('p1', 'sk-12345678');
  await st.delete('p1');
  assert.equal(st.get('p1'), null);
});
