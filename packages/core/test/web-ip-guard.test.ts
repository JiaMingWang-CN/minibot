import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedAddress } from '../src/web/ip-guard.ts';

test('守卫 IPv4：回环、私有、链路本地、CGNAT、保留与组播一律拒绝', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '192.0.2.10',
  ]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  assert.equal(isBlockedAddress('93.184.216.34'), false);
  assert.equal(isBlockedAddress('8.8.8.8'), false);
});

test('守卫 IPv6：回环、唯一本地、链路本地、组播与 IPv4 映射形式', () => {
  for (const ip of ['::1', 'fd00::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::', 'ff02::1', '2001:db8::1']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  assert.equal(isBlockedAddress('2606:4700::1'), false);
  assert.equal(isBlockedAddress('2001:4860:4860::8888'), false);
});

test('解析不了的地址按拒绝处理', () => {
  assert.equal(isBlockedAddress('not-an-ip'), true);
  assert.equal(isBlockedAddress('127.0.0.999'), true);
  assert.equal(isBlockedAddress(''), true);
});

test('守卫 NAT64 与 6to4：内嵌的 IPv4 按 IPv4 规则判断', () => {
  assert.equal(isBlockedAddress('64:ff9b::a00:1'), true); // 10.0.0.1
  assert.equal(isBlockedAddress('64:ff9b::7f00:1'), true); // 127.0.0.1
  assert.equal(isBlockedAddress('64:ff9b:1::1'), true); // 本地用途 NAT64
  assert.equal(isBlockedAddress('2002:c0a8:101::1'), true); // 192.168.1.1
  assert.equal(isBlockedAddress('64:ff9b::808:808'), false); // 8.8.8.8
  assert.equal(isBlockedAddress('2002:808:808::1'), false);
});
