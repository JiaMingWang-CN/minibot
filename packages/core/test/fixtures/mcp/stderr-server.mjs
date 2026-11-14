import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

// 启动时先往 stderr 写满 4MB；没人读 stderr 的话这里会被阻塞，永远走不到 MCP 握手
const chunk = `${'x'.repeat(1023)}\n`;
await new Promise((resolve) => {
  let n = 0;
  const write = () => {
    while (n < 4096) {
      n += 1;
      if (!process.stderr.write(chunk)) {
        process.stderr.once('drain', write);
        return;
      }
    }
    resolve();
  };
  write();
});
if (process.env.STDERR_DONE_FILE) writeFileSync(process.env.STDERR_DONE_FILE, 'done');

const server = new McpServer({ name: 'stderr', version: '1.0.0' });
await server.connect(new StdioServerTransport());
