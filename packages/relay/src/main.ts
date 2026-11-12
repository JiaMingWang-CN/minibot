import { startRelay } from './relay.ts';

const token = process.env['RELAY_TOKEN'] ?? '';
if (token.length < 16) {
  console.error('必须设置环境变量 RELAY_TOKEN，且至少 16 个字符');
  process.exit(1);
}

const host = process.env['RELAY_HOST'] ?? '127.0.0.1';
const port = Number(process.env['RELAY_PORT'] ?? '8787');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('RELAY_PORT 必须是 1 到 65535 之间的整数');
  process.exit(1);
}

const trustProxy = process.env['RELAY_TRUST_PROXY'] === '1';
const relay = await startRelay({ host, port, token, trustProxy, log: (message) => console.log(message) });
console.log(`minibot 中继已启动：${host}:${relay.port}`);

const shutdown = (): void => {
  void relay.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
