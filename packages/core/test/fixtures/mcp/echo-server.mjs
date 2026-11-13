import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const mode = process.env.MCP_TEST_MODE ?? 'normal';

if (mode === 'child') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (process.env.CHILD_PID_FILE) writeFileSync(process.env.CHILD_PID_FILE, String(child.pid));
}

const server = new McpServer({ name: process.env.MCP_SERVER_NAME ?? 'fixture', version: '1.0.0' });

server.registerTool(
  'echo',
  { description: 'echo back', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }),
);

server.registerTool('env', { description: 'dump environment' }, async () => ({
  content: [{ type: 'text', text: JSON.stringify(process.env) }],
}));

server.registerTool('slow', { description: 'sleep two seconds' }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return { content: [{ type: 'text', text: 'slow done' }] };
});

server.registerTool('get.page', { description: 'dot name' }, async () => ({
  content: [{ type: 'text', text: 'page' }],
}));

server.registerTool('image', { description: 'mixed content' }, async () => ({
  content: [
    { type: 'text', text: 'a' },
    {
      type: 'image',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      mimeType: 'image/png',
    },
    { type: 'text', text: 'b' },
  ],
}));

server.registerTool('crash', { description: 'exit after call' }, async () => {
  setTimeout(() => process.exit(1), 50);
  return { content: [{ type: 'text', text: 'bye' }] };
});

await server.connect(new StdioServerTransport());
