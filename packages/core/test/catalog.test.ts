import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newBot } from '../src/config/config.ts';
import { TOOL_SPECS } from '../src/tools/registry.ts';
import { ToolCatalog, type ExternalTool } from '../src/tools/catalog.ts';

function externalTool(name: string): ExternalTool {
  return {
    spec: { name, description: `工具 ${name}`, parameters: { type: 'object', properties: {} } },
    source: { kind: 'mcp', serverId: 's1', serverName: 'S1', toolName: name },
    summarize: () => `调用 ${name}`,
    run: async () => ({ content: 'ok', isError: false }),
  };
}

function provider(tools: ExternalTool[]) {
  return { toolsFor: async () => tools };
}

test('快照合并：内置 6 个工具在前，随后是注册 provider 提供的工具', async () => {
  const catalog = new ToolCatalog();
  catalog.register(provider([externalTool('fake__echo')]));
  const toolset = await catalog.snapshot(newBot('b1'));
  assert.deepEqual(
    toolset.specs.map((s) => s.name),
    [...TOOL_SPECS.map((t) => t.name), 'fake__echo'],
  );
  assert.equal(toolset.external('fake__echo')?.spec.name, 'fake__echo');
  assert.equal(toolset.external('read_file'), undefined);
});

test('外部工具不能顶替内置工具：同名 read_file 被丢弃，执行仍走内置逻辑', async () => {
  const catalog = new ToolCatalog();
  catalog.register(provider([externalTool('read_file')]));
  const toolset = await catalog.snapshot(newBot('b1'));
  assert.equal(toolset.specs.filter((s) => s.name === 'read_file').length, 1);
  assert.equal(toolset.external('read_file'), undefined);
});

test('已收录的外部工具重名时丢弃后一个', async () => {
  const catalog = new ToolCatalog();
  catalog.register(provider([externalTool('dup__x')]));
  catalog.register(provider([externalTool('dup__x')]));
  const toolset = await catalog.snapshot(newBot('b1'));
  assert.equal(toolset.specs.filter((s) => s.name === 'dup__x').length, 1);
});
