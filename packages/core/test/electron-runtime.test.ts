import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// 桌面端跑在 Electron 里，它的 node:crypto 基于 BoringSSL，与 Node 自带的 OpenSSL 支持的算法不同
// （例如没有 chacha20-poly1305）。加密相关的测试要在 Electron 运行时里再跑一遍。
const ELECTRON_SUITES = ['noise.test.ts', 'channel.test.ts', 'remote-interop.test.ts'];

test('Noise 与加密信道在 Electron 运行时里可用', () => {
  const electron = createRequire(import.meta.url)('electron') as string;
  const files = ELECTRON_SUITES.map((name) => fileURLToPath(new URL(name, import.meta.url)));
  // 同时去掉 NODE_OPTIONS（容器里的 --use-openssl-ca 等 Electron 不认）。
  // 去掉 node --test 给子进程设的 NODE_TEST_CONTEXT：带着它，Electron 会把结果当子测试上报、退出码恒为 0
  const { NODE_TEST_CONTEXT: _, NODE_OPTIONS: __, ...env } = process.env;
  const result = spawnSync(electron, ['--test', ...files], {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
