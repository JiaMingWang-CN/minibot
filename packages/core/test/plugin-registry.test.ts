import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPaths, type DataPaths } from '../src/paths.ts';
import { newBot } from '../src/config/config.ts';
import type { Bot } from '../src/config/types.ts';
import { SecretSet } from '../src/secrets/redact.ts';
import { SecretStore, type KeyCrypto } from '../src/secrets/store.ts';
import { McpManager } from '../src/mcp/manager.ts';
import { McpToolProvider } from '../src/mcp/tools.ts';
import { ToolCatalog } from '../src/tools/catalog.ts';
import { PluginService, type InstalledPlugin } from '../src/plugins/registry.ts';

const ECHO = fileURLToPath(new URL('./fixtures/mcp/echo-server.mjs', import.meta.url));

function fakeCrypto(): KeyCrypto {
  return {
    backend: () => 'os',
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decrypt: (buf) => Buffer.from(buf.toString('utf8').slice(4), 'base64').toString('utf8'),
  };
}

interface Harness {
  root: string;
  paths: DataPaths;
  secretStore: SecretStore;
  manager: McpManager;
  service: PluginService;
  bots: Bot[];
  close(): Promise<void>;
}

async function harness(builtinPluginsDir?: string): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-plug-'));
  const paths = dataPaths(root);
  await fs.mkdir(paths.root, { recursive: true });
  const secretStore = new SecretStore(paths.secrets, fakeCrypto(), new SecretSet());
  await secretStore.load();
  const bots: Bot[] = [];
  // eslint-disable-next-line prefer-const
  let service!: PluginService;
  const manager = new McpManager({
    loadServers: () => service.serverConfigs(),
    enabledServerIds: async () => service.serverIdsInUse(bots, await service.installed()),
    secretStore,
    emit: () => {},
    home: root,
    connectTimeoutMs: 15_000,
  });
  service = new PluginService({
    paths,
    secretStore,
    mcp: manager,
    ...(builtinPluginsDir !== undefined ? { builtinPluginsDir } : {}),
    listBots: async () => bots,
    enableForMainBot: async (kind, id) => {
      const main = bots[0];
      if (main !== undefined && kind === 'plugins' && !main.extensions.plugins.includes(id)) {
        main.extensions.plugins = [...main.extensions.plugins, id];
      }
    },
    removeFromAllBots: async (kind, id) => {
      for (const bot of bots) {
        if (kind === 'plugins') {
          bot.extensions.plugins = bot.extensions.plugins.filter((x) => x !== id);
          bot.pluginExclusions = bot.pluginExclusions.filter((x) => !x.startsWith(`plugin:${id}:`));
        }
      }
    },
  });
  return { root, paths, secretStore, manager, service, bots, close: () => manager.stop() };
}

async function makePlugin(
  pluginsDir: string,
  name: string,
  opts: {
    config?: { key: string; secret: boolean; required: boolean }[];
    servers: { name: string; configValue?: boolean }[];
  },
): Promise<void> {
  const dir = path.join(pluginsDir, name);
  await fs.mkdir(dir, { recursive: true });
  const manifest = {
    name,
    version: '1.0.0',
    description: '测试插件',
    config: (opts.config ?? []).map((c) => ({
      key: c.key,
      title: c.key,
      description: c.key,
      secret: c.secret,
      required: c.required,
    })),
  };
  await fs.writeFile(path.join(dir, 'minibot-plugin.json'), JSON.stringify(manifest, null, 2));
  const mcpServers: Record<string, unknown> = {};
  for (const server of opts.servers) {
    const env: Record<string, string> = { MCP_SERVER_NAME: server.name };
    if (server.configValue === true) env['TOKEN'] = '${config.TOKEN}';
    mcpServers[server.name] = { command: process.execPath, args: [ECHO], env };
  }
  await fs.writeFile(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers }, null, 2));
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function toolNames(catalog: ToolCatalog, bot: Bot): Promise<string[]> {
  return catalog.snapshot(bot).then((s) => s.specs.map((t) => t.name));
}

test('未连接不启动、连接后启动、密钥不落 extensions.json、bot 启用插件即启用其 server', async () => {
  const h = await harness();
  try {
    await makePlugin(h.paths.pluginsDir, 'ok-plugin', {
      config: [{ key: 'TOKEN', secret: true, required: true }],
      servers: [{ name: 'echo', configValue: true }],
    });
    const entry: InstalledPlugin = {
      name: 'ok-plugin',
      version: '1.0.0',
      builtin: false,
      source: { kind: 'local' },
      enabled: true,
      serverIds: ['plugin:ok-plugin:echo'],
    };
    await h.service.addInstalled(entry);

    let views = await h.service.list();
    assert.equal(views.length, 1);
    assert.equal(views[0]!.status, 'not_connected');
    assert.equal(h.manager.states().length, 0);

    await h.service.connect('ok-plugin', { TOKEN: 'sk-secret-1' });
    await waitFor(() => h.manager.states().some((s) => s.status === 'connected'));
    views = await h.service.list();
    assert.equal(views[0]!.status, 'connected');

    const raw = await fs.readFile(h.paths.extensionsJson, 'utf8');
    assert.equal(raw.includes('sk-secret-1'), false);
    assert.equal(await h.secretStore.get('plugin:ok-plugin:config:TOKEN'), 'sk-secret-1');

    const catalog = new ToolCatalog();
    catalog.register(new McpToolProvider({ manager: h.manager, loadServers: () => h.service.serverConfigs() }));
    const enabledBot = newBot('b1');
    enabledBot.extensions.plugins = ['ok-plugin'];
    const otherBot = newBot('b2');
    assert.ok((await toolNames(catalog, enabledBot)).includes('echo__echo'));
    assert.equal((await toolNames(catalog, otherBot)).includes('echo__echo'), false);
  } finally {
    await h.close();
  }
});

test('单独关掉插件里的 server；停用后工具消失、再启用恢复', async () => {
  const h = await harness();
  try {
    await makePlugin(h.paths.pluginsDir, 'two', {
      config: [{ key: 'TOKEN', secret: true, required: true }],
      servers: [{ name: 'echo1', configValue: true }, { name: 'echo2', configValue: true }],
    });
    await h.service.addInstalled({
      name: 'two',
      version: '1.0.0',
      builtin: false,
      source: { kind: 'local' },
      enabled: true,
      serverIds: ['plugin:two:echo1', 'plugin:two:echo2'],
    });
    await h.service.connect('two', { TOKEN: 'sk-2' });
    await waitFor(() => h.manager.states().filter((s) => s.status === 'connected').length === 2);

    const catalog = new ToolCatalog();
    catalog.register(new McpToolProvider({ manager: h.manager, loadServers: () => h.service.serverConfigs() }));
    const bot = newBot('b1');
    bot.extensions.plugins = ['two'];
    bot.pluginExclusions = ['plugin:two:echo1'];
    const names = await toolNames(catalog, bot);
    assert.equal(names.includes('echo1__echo'), false);
    assert.ok(names.includes('echo2__echo'));

    await h.service.setEnabled('two', false);
    await waitFor(() => h.manager.states().every((s) => s.status === 'stopped'));
    const afterDisable = await toolNames(catalog, bot);
    assert.equal(afterDisable.includes('echo1__echo'), false);
    assert.equal(afterDisable.includes('echo2__echo'), false);

    await h.service.setEnabled('two', true);
    await waitFor(() => h.manager.states().filter((s) => s.status === 'connected').length === 2);
    assert.ok((await toolNames(catalog, bot)).includes('echo2__echo'));
  } finally {
    await h.close();
  }
});

test('卸载清理：目录、密钥、bot 引用、登记都不存在', async () => {
  const h = await harness();
  try {
    await makePlugin(h.paths.pluginsDir, 'gone', {
      config: [{ key: 'TOKEN', secret: true, required: true }],
      servers: [{ name: 'echo', configValue: true }],
    });
    const bot = newBot('b1');
    bot.extensions.plugins = ['gone'];
    bot.pluginExclusions = ['plugin:gone:echo', 'plugin:gone:skill'];
    h.bots.push(bot);
    await h.service.addInstalled({
      name: 'gone',
      version: '1.0.0',
      builtin: false,
      source: { kind: 'local' },
      enabled: true,
      serverIds: ['plugin:gone:echo'],
    });
    await h.service.connect('gone', { TOKEN: 'sk-gone' });
    await waitFor(() => h.manager.states().some((s) => s.status === 'connected'));
    await h.secretStore.set('mcp:plugin:gone:echo:oauth', '{"tokens":"t"}');

    await h.service.uninstall('gone');
    assert.equal(await fs.stat(path.join(h.paths.pluginsDir, 'gone')).then(() => true, () => false), false);
    assert.equal(await h.secretStore.get('plugin:gone:config:TOKEN'), null);
    assert.equal(await h.secretStore.get('mcp:plugin:gone:echo:oauth'), null);
    assert.equal((await h.service.installed()).length, 0);
    assert.deepEqual(bot.extensions.plugins, []);
    assert.deepEqual(bot.pluginExclusions, []);
    assert.equal(h.manager.states().length, 0);
  } finally {
    await h.close();
  }
});

test('预装不可删：uninstall(tavily) 失败', async () => {
  const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minibot-builtin-'));
  const tavilyDir = path.join(builtinDir, 'tavily');
  await fs.mkdir(tavilyDir, { recursive: true });
  await fs.writeFile(
    path.join(tavilyDir, 'minibot-plugin.json'),
    JSON.stringify({ name: 'tavily', version: '1.0.0', description: '搜索', config: [] }),
  );
  await fs.writeFile(
    path.join(tavilyDir, 'mcp.json'),
    JSON.stringify({ mcpServers: { tavily: { url: 'https://mcp.tavily.com/mcp/' } } }),
  );
  const h = await harness(builtinDir);
  try {
    await h.service.registerBuiltin();
    const views = await h.service.list();
    const tavily = views.find((v) => v.name === 'tavily');
    assert.ok(tavily !== undefined);
    assert.equal(tavily!.builtin, true);
    await assert.rejects(h.service.uninstall('tavily'), /预装插件不能删除/);
  } finally {
    await h.close();
  }
});

test('插件 stdio server 未写 cwd 时默认在插件目录运行', async () => {
  const h = await harness();
  try {
    await makePlugin(h.paths.pluginsDir, 'cwdp', { servers: [{ name: 'echo' }] });
    await h.service.addInstalled({
      name: 'cwdp',
      version: '1.0.0',
      builtin: false,
      source: { kind: 'local' },
      enabled: true,
      serverIds: ['plugin:cwdp:echo'],
    });
    const [config] = await h.service.serverConfigs();
    assert.ok(config !== undefined && config.transport.type === 'stdio');
    if (config.transport.type === 'stdio') assert.equal(config.transport.cwd, path.join(h.paths.pluginsDir, 'cwdp'));
  } finally {
    await h.close();
  }
});

test('已启用的预装插件 server 不依赖任何 bot 的插件列表，始终算在用', async () => {
  const h = await harness();
  try {
    const bot = newBot('b1');
    const plugins: InstalledPlugin[] = [
      { name: 'tavily', version: '1.0.0', builtin: true, source: { kind: 'builtin' }, enabled: true, serverIds: ['plugin:tavily:tavily'] },
      { name: 'deepseek', version: '1.0.0', builtin: true, source: { kind: 'builtin' }, enabled: false, serverIds: ['plugin:deepseek:deepseek'] },
    ];
    const ids = h.service.serverIdsInUse([bot], plugins);
    assert.ok(ids.has('plugin:tavily:tavily'));
    assert.equal(ids.has('plugin:deepseek:deepseek'), false);
  } finally {
    await h.close();
  }
});
