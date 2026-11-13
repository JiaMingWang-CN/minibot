// 已装插件登记、连接、启用与卸载（扩展第 4 期 Task 2）。
// 插件里的 MCP server 转成第 3 期的 McpServerConfig（origin.kind = 'plugin'），由 McpManager 统一管理。

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Bot } from '../config/types.ts';
import type { DataPaths } from '../paths.ts';
import type { SecretStore } from '../secrets/store.ts';
import type { McpManager, McpServerState } from '../mcp/manager.ts';
import { shortNameFrom, type McpServerConfig, type McpServerDraft, type McpValue } from '../mcp/config.ts';
import { loadExtensions, saveExtensions, type ExtensionsFile } from '../extensions/store.ts';
import { readPluginBundle, resolvePluginServers, type PluginBundle, type PluginManifest } from './manifest.ts';
import { stageFolder, stageGit, stageZip, lsRemote, type InstallSource, type StageOptions } from './sources.ts';
import { ensureMarketRepo, readMarketEntries, type MarketEntry } from './market.ts';
import { buildPreview, moveDir, type InstallPreview } from './install.ts';
import { diffStdioCommands, type UpdatePreview } from './update.ts';

export type PluginSource =
  | { kind: 'local' }
  | { kind: 'git'; url: string; ref: string | null; commit: string }
  | { kind: 'market'; marketUrl: string; url: string; ref: string | null; path: string | null; commit: string }
  | { kind: 'builtin' };

export interface InstalledPlugin {
  name: string;
  version: string;
  builtin: boolean;
  source: PluginSource;
  enabled: boolean;
  serverIds: string[];
  /** 非敏感配置值，敏感值存密钥库 */
  config?: Record<string, string>;
}

export type PluginStatus = 'not_connected' | 'connected' | 'error';

export interface PluginView extends InstalledPlugin {
  manifest: PluginManifest;
  status: PluginStatus;
  problems: string[];
  /** 需要 OAuth 登录的 server id（界面据此显示“登录”） */
  loginServerIds: string[];
}

export interface PluginServiceOptions {
  paths: DataPaths;
  secretStore: SecretStore;
  mcp: McpManager;
  builtinPluginsDir?: string;
  listBots: () => Promise<Bot[]>;
  enableForMainBot: (kind: 'plugins' | 'mcpServers' | 'skills', id: string) => Promise<void>;
  removeFromAllBots: (kind: 'plugins' | 'mcpServers' | 'skills', id: string) => Promise<void>;
  /** 允许的 Git 地址判定；默认只允许 https://。测试可注入 */
  gitUrlOk?: (url: string) => boolean;
  /** zip 解压限制；默认 5000 条、100 MB。测试可注入更小的值 */
  zipLimits?: { maxEntries?: number; maxBytes?: number };
  /** 测试注入：目录移动失败模拟 */
  moveDirImpl?: (src: string, dest: string) => Promise<void>;
  /** 读取某个已有供应商当前 Key（DeepSeek 插件复用服务用）；不存在或无 Key 时返回 null */
  providerKey?: (providerId: string) => string | null;
}

interface PendingInstall {
  tempBase: string;
  pluginRoot: string;
  source: PluginSource;
  expires: number;
}

interface PendingUpdate {
  tempBase: string;
  newRoot: string;
  source: PluginSource;
  name: string;
  expires: number;
}

const MANIFEST_FILE = 'minibot-plugin.json';

export function pluginServerId(pluginName: string, serverName: string): string {
  return `plugin:${pluginName}:${serverName}`;
}

export function pluginConfigSecretKey(pluginName: string, key: string): string {
  return `plugin:${pluginName}:config:${key}`;
}

/** 把解析出的草稿变成可交给 McpManager 的配置。
 *  第三方插件的 secret 值此时已是明文，嵌入内存配置但不落盘；
 *  预装插件的 secret 保留 { secret: true }，由密钥库按 mcp 键取值（保证每次启动取最新 Key）。 */
function toServerConfig(plugin: InstalledPlugin, draft: McpServerDraft): McpServerConfig {
  const t = draft.transport;
  let transport: McpServerConfig['transport'];
  if (t.type === 'stdio') {
    let command = t.command;
    let args = [...t.args];
    let usedRuntime = false;
    if (plugin.builtin) {
      const replaceRuntime = (text: string): string => {
        if (!text.includes('${RUNTIME}')) return text;
        usedRuntime = true;
        return text.split('${RUNTIME}').join(process.execPath);
      };
      command = replaceRuntime(command);
      args = args.map(replaceRuntime);
    }
    const env: Record<string, McpValue> = {};
    for (const [name, value] of Object.entries(t.env)) {
      env[name] = plugin.builtin && value.secret ? { secret: true } : { secret: false, value: value.value };
    }
    if (usedRuntime) env['ELECTRON_RUN_AS_NODE'] = { secret: false, value: '1' };
    transport = { type: 'stdio', command, args, cwd: t.cwd, env };
  } else if (plugin.builtin && plugin.name === 'tavily' && plugin.config?.oauth === 'true') {
    transport = { type: 'http', url: t.url, headers: {}, auth: 'oauth' };
  } else {
    const headers: Record<string, McpValue> = {};
    for (const [name, value] of Object.entries(t.headers)) {
      headers[name] = plugin.builtin && value.secret ? { secret: true } : { secret: false, value: value.value };
    }
    transport = { type: 'http', url: t.url, headers, auth: t.auth };
  }
  return {
    id: pluginServerId(plugin.name, draft.name),
    name: draft.name,
    shortName: draft.shortName.length > 0 ? draft.shortName : shortNameFrom(draft.name),
    transport,
    timeoutMs: draft.timeoutMs,
    origin: { kind: 'plugin', pluginId: plugin.name },
  };
}

export class PluginService {
  private readonly opts: PluginServiceOptions;
  private readonly pending = new Map<string, PendingInstall>();
  private readonly pendingUpdates = new Map<string, PendingUpdate>();

  constructor(options: PluginServiceOptions) {
    this.opts = options;
  }

  pluginRoot(plugin: InstalledPlugin): string {
    if (plugin.builtin) {
      return this.opts.builtinPluginsDir === undefined ? '' : path.join(this.opts.builtinPluginsDir, plugin.name);
    }
    return path.join(this.opts.paths.pluginsDir, plugin.name);
  }

  async installed(): Promise<InstalledPlugin[]> {
    return (await loadExtensions(this.opts.paths)).plugins;
  }

  /** 已启用插件的 skill 目录（供 SkillService 扫描） */
  async installedSkillDirs(): Promise<{ pluginName: string; dirs: string[] }[]> {
    const plugins = (await loadExtensions(this.opts.paths)).plugins;
    const out: { pluginName: string; dirs: string[] }[] = [];
    for (const plugin of plugins) {
      if (!plugin.enabled) continue;
      const { bundle, problem } = await this.tryBundle(plugin);
      if (problem !== null || bundle.skillDirs.length === 0) continue;
      out.push({ pluginName: plugin.name, dirs: bundle.skillDirs });
    }
    return out;
  }

  /** 读取插件清单；失败时返回一个带 problems 的占位 bundle，供列表展示错误 */
  private async tryBundle(plugin: InstalledPlugin): Promise<{ bundle: PluginBundle; problem: string | null }> {
    const root = this.pluginRoot(plugin);
    try {
      return { bundle: await readPluginBundle(root), problem: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        bundle: {
          manifest: { name: plugin.name, version: plugin.version, description: '', config: [] },
          root,
          mcp: [],
          skillDirs: [],
          problems: [message],
        },
        problem: message,
      };
    }
  }

  private serverIdsOf(plugin: InstalledPlugin, bundle: PluginBundle): string[] {
    return bundle.mcp.map((draft) => pluginServerId(plugin.name, draft.name));
  }

  private valuesFor(plugin: InstalledPlugin, bundle: PluginBundle): Record<string, string> {
    const out: Record<string, string> = {};
    for (const field of bundle.manifest.config) {
      if (field.secret) {
        const value = this.opts.secretStore.get(pluginConfigSecretKey(plugin.name, field.key));
        if (value !== null) out[field.key] = value;
      } else {
        const value = plugin.config?.[field.key];
        if (value !== undefined) out[field.key] = value;
      }
    }
    return out;
  }

  private requiredComplete(bundle: PluginBundle, values: Record<string, string>): boolean {
    return bundle.manifest.config.every(
      (field) => !field.required || (values[field.key] !== undefined && values[field.key]!.length > 0),
    );
  }

  private providerKeyFor(plugin: InstalledPlugin): string | null {
    const providerId = plugin.config?.['providerId'];
    if (providerId === undefined) return null;
    return this.opts.providerKey?.(providerId) ?? null;
  }

  /** 连接是否具备必要配置（搜索插件二选一） */
  private configuredComplete(plugin: InstalledPlugin, bundle: PluginBundle, values: Record<string, string>): boolean {
    if (plugin.builtin && plugin.name === 'deepseek') {
      if (plugin.config?.['providerId'] !== undefined) return true;
      return (values['api_key']?.length ?? 0) > 0;
    }
    if (plugin.builtin && plugin.name === 'tavily') {
      if (plugin.config?.['oauth'] === 'true') return true;
      return (values['api_key']?.length ?? 0) > 0;
    }
    return this.requiredComplete(bundle, values);
  }

  /** DeepSeek 选的已有服务被删除或没有 Key */
  private providerBroken(plugin: InstalledPlugin): boolean {
    if (!plugin.builtin || plugin.name !== 'deepseek') return false;
    if (plugin.config?.['providerId'] === undefined) return false;
    return this.providerKeyFor(plugin) === null;
  }

  private async pluginState(
    plugin: InstalledPlugin,
  ): Promise<{ bundle: PluginBundle; values: Record<string, string>; complete: boolean; broken: boolean; problem: string | null }> {
    const { bundle, problem } = await this.tryBundle(plugin);
    const values = this.valuesFor(plugin, bundle);
    const complete = problem === null && this.configuredComplete(plugin, bundle, values);
    const broken = problem === null && this.providerBroken(plugin);
    return { bundle, values, complete, broken, problem };
  }

  /** 插件 server 的当前配置；只包含全局启用且必要配置已填的插件 */
  async serverConfigs(): Promise<McpServerConfig[]> {
    const plugins = (await loadExtensions(this.opts.paths)).plugins;
    const out: McpServerConfig[] = [];
    for (const plugin of plugins) {
      if (!plugin.enabled) continue;
      const state = await this.pluginState(plugin);
      if (state.problem !== null || state.broken || !state.complete || state.bundle.mcp.length === 0) continue;
      try {
        const providerKey = this.providerKeyFor(plugin);
        for (const draft of resolvePluginServers(state.bundle, state.values)) {
          const config = toServerConfig(plugin, draft);
          // DeepSeek 复用已有服务：每次生成配置都取该服务当前的 Key（只在内存里，不落盘）
          if (providerKey !== null && config.transport.type === 'stdio' && 'DEEPSEEK_API_KEY' in config.transport.env) {
            config.transport.env['DEEPSEEK_API_KEY'] = { secret: false, value: providerKey };
          }
          out.push(config);
        }
      } catch {
        // 单个插件的 server 生成失败不影响其他插件
      }
    }
    return out;
  }

  async list(): Promise<PluginView[]> {
    const plugins = (await loadExtensions(this.opts.paths)).plugins;
    const states = new Map<string, McpServerState>(this.opts.mcp.states().map((state) => [state.id, state]));
    const views: PluginView[] = [];
    for (const plugin of plugins) {
      const state = await this.pluginState(plugin);
      const serverIds = this.serverIdsOf(plugin, state.bundle);
      let status: PluginStatus;
      if (!plugin.enabled || !state.complete) status = 'not_connected';
      else if (state.broken) status = 'error';
      else if (serverIds.length === 0) status = 'connected';
      else if (serverIds.every((id) => states.get(id)?.status === 'connected')) status = 'connected';
      else status = 'error';
      const loginServerIds = plugin.enabled ? serverIds.filter((id) => states.get(id)?.status === 'needs_login') : [];
      views.push({ ...plugin, serverIds, manifest: state.bundle.manifest, status, problems: state.bundle.problems, loginServerIds });
    }
    return views;
  }

  async connect(name: string, values: Record<string, string>): Promise<void> {
    const file = await loadExtensions(this.opts.paths);
    const plugin = file.plugins.find((p) => p.name === name);
    if (plugin === undefined) throw new Error(`插件不存在：${name}`);
    let bundle: PluginBundle;
    try {
      bundle = await readPluginBundle(this.pluginRoot(plugin));
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }

    if (plugin.builtin && (name === 'deepseek' || name === 'tavily')) {
      await this.connectSearch(plugin, bundle, values, file);
      return;
    }

    const missing = bundle.manifest.config
      .filter((field) => field.required && (values[field.key] === undefined || values[field.key]!.trim().length === 0))
      .map((field) => field.key);
    if (missing.length > 0) throw new Error(`请填写必填配置：${missing.join('、')}`);

    const secretFields = bundle.manifest.config.filter(
      (field) => field.secret && values[field.key] !== undefined && values[field.key]!.length > 0,
    );
    if (secretFields.length > 0 && !this.opts.secretStore.canPersist()) {
      throw new Error('当前系统没有可用的密钥库，无法保存这个插件的密钥');
    }
    for (const field of secretFields) {
      await this.opts.secretStore.set(pluginConfigSecretKey(name, field.key), values[field.key]!);
    }

    const storedConfig: Record<string, string> = { ...(plugin.config ?? {}) };
    for (const field of bundle.manifest.config) {
      if (field.secret) continue;
      const value = values[field.key];
      if (value !== undefined) storedConfig[field.key] = value;
      else delete storedConfig[field.key];
    }
    plugin.config = storedConfig;
    plugin.serverIds = this.serverIdsOf(plugin, bundle);
    await saveExtensions(this.opts.paths, file);

    for (const draft of resolvePluginServers(bundle, this.valuesFor(plugin, bundle))) {
      await this.opts.mcp.connect(pluginServerId(name, draft.name)).catch(() => undefined);
    }
  }

  /** 预装搜索插件的连接：DeepSeek 二选一（复用服务 / 填 Key），Tavily 二选一（填 Key / OAuth） */
  private async connectSearch(
    plugin: InstalledPlugin,
    bundle: PluginBundle,
    values: Record<string, string>,
    file: ExtensionsFile,
  ): Promise<void> {
    const name = plugin.name;
    const config: Record<string, string> = { ...(plugin.config ?? {}) };
    if (name === 'deepseek') {
      const providerId = values['providerId'];
      const apiKey = values['api_key'];
      if (providerId !== undefined && providerId.length > 0) {
        const key = this.opts.providerKey?.(providerId) ?? null;
        if (key === null) throw new Error('所选的 DeepSeek 服务不存在或没有 API Key');
        config['providerId'] = providerId;
        // Key 在每次生成 server 配置时从该服务实时读取，这里清掉之前单独填写的 Key
        await this.opts.secretStore.delete(pluginConfigSecretKey(name, 'api_key'));
        await this.opts.secretStore.delete(`mcp:${pluginServerId(name, 'deepseek')}:env:DEEPSEEK_API_KEY`);
      } else if (apiKey !== undefined && apiKey.length > 0) {
        if (!this.opts.secretStore.canPersist()) throw new Error('当前系统没有可用的密钥库，无法保存这个插件的密钥');
        await this.opts.secretStore.set(pluginConfigSecretKey(name, 'api_key'), apiKey);
        await this.opts.secretStore.set(`mcp:${pluginServerId(name, 'deepseek')}:env:DEEPSEEK_API_KEY`, apiKey);
        delete config['providerId'];
      } else {
        throw new Error('请填写 API Key 或选择已有的 DeepSeek 服务');
      }
    } else {
      const oauth = values['oauth'] === 'true' || values['oauth'] === '1';
      const apiKey = values['api_key'];
      if (oauth) {
        config['oauth'] = 'true';
        await this.opts.secretStore.delete(pluginConfigSecretKey(name, 'api_key'));
        await this.opts.secretStore.delete(`mcp:${pluginServerId(name, 'tavily')}:header:Authorization`);
      } else if (apiKey !== undefined && apiKey.length > 0) {
        if (!this.opts.secretStore.canPersist()) throw new Error('当前系统没有可用的密钥库，无法保存这个插件的密钥');
        await this.opts.secretStore.set(pluginConfigSecretKey(name, 'api_key'), apiKey);
        await this.opts.secretStore.set(`mcp:${pluginServerId(name, 'tavily')}:header:Authorization`, `Bearer ${apiKey}`);
        // 改回 Key 连接：清掉之前 OAuth 登录留下的 token
        await this.opts.secretStore.delete(`mcp:${pluginServerId(name, 'tavily')}:oauth`);
        delete config['oauth'];
      } else {
        throw new Error('请填写 API Key 或选择用 Tavily 账号登录');
      }
    }
    plugin.config = config;
    plugin.serverIds = this.serverIdsOf(plugin, bundle);
    await saveExtensions(this.opts.paths, file);
    for (const id of plugin.serverIds) await this.opts.mcp.connect(id).catch(() => undefined);
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const file = await loadExtensions(this.opts.paths);
    const plugin = file.plugins.find((p) => p.name === name);
    if (plugin === undefined) throw new Error(`插件不存在：${name}`);
    plugin.enabled = enabled;
    await saveExtensions(this.opts.paths, file);
    const { bundle } = await this.tryBundle(plugin);
    const serverIds = this.serverIdsOf(plugin, bundle);
    if (!enabled) {
      for (const id of serverIds) await this.opts.mcp.disconnect(id).catch(() => undefined);
      return;
    }
    const state = await this.pluginState(plugin);
    if (state.complete && !state.broken) {
      for (const id of serverIds) await this.opts.mcp.connect(id).catch(() => undefined);
    }
  }

  async uninstall(name: string): Promise<void> {
    const file = await loadExtensions(this.opts.paths);
    const plugin = file.plugins.find((p) => p.name === name);
    if (plugin === undefined) throw new Error(`插件不存在：${name}`);
    if (plugin.builtin) throw new Error('预装插件不能删除');
    const { bundle } = await this.tryBundle(plugin);
    for (const id of this.serverIdsOf(plugin, bundle)) await this.opts.mcp.disconnect(id).catch(() => undefined);
    await fs.rm(path.join(this.opts.paths.pluginsDir, name), { recursive: true, force: true });
    for (const field of bundle.manifest.config) {
      if (field.secret) await this.opts.secretStore.delete(pluginConfigSecretKey(name, field.key));
    }
    // 插件 server 在密钥库里的 OAuth token、请求头 / 环境变量密钥
    for (const id of new Set([...plugin.serverIds, ...this.serverIdsOf(plugin, bundle)])) {
      for (const key of this.opts.secretStore.keys().filter((k) => k.startsWith(`mcp:${id}:`))) {
        await this.opts.secretStore.delete(key);
      }
    }
    await this.opts.removeFromAllBots('plugins', name);
    file.plugins = file.plugins.filter((p) => p.name !== name);
    await saveExtensions(this.opts.paths, file);
    await this.opts.mcp.sync().catch(() => undefined);
  }

  /** 登记一个已装插件（安装流水线 / 测试用） */
  async addInstalled(plugin: InstalledPlugin): Promise<void> {
    const file = await loadExtensions(this.opts.paths);
    if (file.plugins.some((p) => p.name === plugin.name)) throw new Error(`已安装同名插件：${plugin.name}`);
    file.plugins = [...file.plugins, plugin];
    await saveExtensions(this.opts.paths, file);
  }

  // —— 安装流水线与市场（Task 3）——

  private stageOptions(): StageOptions {
    const opts: StageOptions = {};
    if (this.opts.gitUrlOk !== undefined) opts.gitUrlOk = this.opts.gitUrlOk;
    if (this.opts.zipLimits?.maxEntries !== undefined) opts.maxZipEntries = this.opts.zipLimits.maxEntries;
    if (this.opts.zipLimits?.maxBytes !== undefined) opts.maxZipBytes = this.opts.zipLimits.maxBytes;
    return opts;
  }

  private async prunePending(): Promise<void> {
    const now = Date.now();
    for (const [token, pending] of [...this.pending]) {
      if (pending.expires <= now) {
        this.pending.delete(token);
        await fs.rm(pending.tempBase, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    for (const [token, update] of [...this.pendingUpdates]) {
      if (update.expires <= now) {
        this.pendingUpdates.delete(token);
        await fs.rm(update.tempBase, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async prepareInstall(src: InstallSource): Promise<InstallPreview> {
    await this.prunePending();
    const token = randomUUID().replace(/-/g, '');
    const tempBase = path.join(this.opts.paths.tmpDir, `plugin-${token}`);
    await fs.mkdir(tempBase, { recursive: true });
    try {
      let pluginRoot = tempBase;
      let source: PluginSource;
      if (src.kind === 'folder') {
        await stageFolder(src.path, tempBase);
        source = { kind: 'local' };
      } else if (src.kind === 'zip') {
        await stageZip(src.path, tempBase, this.stageOptions());
        source = { kind: 'local' };
      } else if (src.kind === 'git') {
        const commit = await stageGit(src.url, src.ref, tempBase, this.stageOptions());
        source = { kind: 'git', url: src.url, ref: src.ref ?? null, commit };
      } else {
        const market = await this.readMarket(src.marketUrl);
        const entry = market.entries.find((item) => item.name === src.name);
        if (entry === undefined) throw new Error(`市场里没有这个插件：${src.name}`);
        const commit = await stageGit(entry.source.git, entry.source.ref, tempBase, this.stageOptions());
        pluginRoot = entry.source.path !== undefined && entry.source.path.length > 0 ? path.join(tempBase, entry.source.path) : tempBase;
        source = {
          kind: 'market',
          marketUrl: src.marketUrl,
          url: entry.source.git,
          ref: entry.source.ref ?? null,
          path: entry.source.path ?? null,
          commit,
        };
      }
      const bundle = await readPluginBundle(pluginRoot);
      const name = bundle.manifest.name;
      if ((await this.installed()).some((p) => p.name === name)) throw new Error(`已安装同名插件：${name}`);
      const target = path.join(this.opts.paths.pluginsDir, name);
      if (await fs.stat(target).then(() => true, () => false)) throw new Error(`已安装同名插件：${name}`);
      const preview = buildPreview(token, bundle, target);
      this.pending.set(token, { tempBase, pluginRoot, source, expires: Date.now() + 30 * 60 * 1000 });
      return preview;
    } catch (err) {
      await fs.rm(tempBase, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  async confirmInstall(token: string): Promise<void> {
    const pending = this.pending.get(token);
    if (pending === undefined) throw new Error('安装已取消或过期');
    try {
      const bundle = await readPluginBundle(pending.pluginRoot);
      const name = bundle.manifest.name;
      if ((await this.installed()).some((p) => p.name === name)) throw new Error(`已安装同名插件：${name}`);
      await fs.mkdir(this.opts.paths.pluginsDir, { recursive: true });
      const target = path.join(this.opts.paths.pluginsDir, name);
      await (this.opts.moveDirImpl ?? moveDir)(pending.pluginRoot, target);
      const entry: InstalledPlugin = {
        name,
        version: bundle.manifest.version,
        builtin: false,
        source: pending.source,
        enabled: true,
        serverIds: bundle.mcp.map((draft) => pluginServerId(name, draft.name)),
      };
      await this.addInstalled(entry);
      await this.opts.enableForMainBot('plugins', name);
    } finally {
      this.pending.delete(token);
      await fs.rm(pending.tempBase, { recursive: true, force: true }).catch(() => undefined);
    }
    await this.opts.mcp.sync().catch(() => undefined);
  }

  async cancelInstall(token: string): Promise<void> {
    const pending = this.pending.get(token);
    if (pending === undefined) return;
    this.pending.delete(token);
    await fs.rm(pending.tempBase, { recursive: true, force: true }).catch(() => undefined);
  }

  private async readMarket(marketUrl: string): Promise<{ entries: MarketEntry[]; problems: string[] }> {
    const dir = await ensureMarketRepo(marketUrl, path.join(this.opts.paths.cacheDir, 'markets'), this.stageOptions());
    return readMarketEntries(dir);
  }

  async listMarket(marketUrl: string): Promise<MarketEntry[]> {
    return (await this.readMarket(marketUrl)).entries;
  }

  async markets(): Promise<string[]> {
    return (await loadExtensions(this.opts.paths)).markets;
  }

  async addMarket(url: string): Promise<void> {
    if (!(this.opts.gitUrlOk?.(url) ?? url.startsWith('https://'))) throw new Error('只支持 https:// 开头的 Git 地址');
    const file = await loadExtensions(this.opts.paths);
    if (!file.markets.includes(url)) {
      file.markets = [...file.markets, url];
      await saveExtensions(this.opts.paths, file);
    }
  }

  async removeMarket(url: string): Promise<void> {
    const file = await loadExtensions(this.opts.paths);
    file.markets = file.markets.filter((m) => m !== url);
    await saveExtensions(this.opts.paths, file);
  }

  // —— 检查更新与更新（Task 4）——

  async checkUpdates(): Promise<{ name: string; current: string; latest: string }[]> {
    await fs.mkdir(this.opts.paths.tmpDir, { recursive: true });
    const file = await loadExtensions(this.opts.paths);
    const out: { name: string; current: string; latest: string }[] = [];
    for (const plugin of file.plugins) {
      if (plugin.builtin) continue;
      try {
        if (plugin.source.kind === 'git') {
          const remote = await lsRemote(plugin.source.url, plugin.source.ref, this.opts.paths.tmpDir, this.stageOptions());
          if (remote !== null && remote !== plugin.source.commit) {
            out.push({ name: plugin.name, current: plugin.version, latest: remote.slice(0, 7) });
          }
        } else if (plugin.source.kind === 'market') {
          const market = await this.readMarket(plugin.source.marketUrl);
          const entry = market.entries.find((item) => item.name === plugin.name);
          if (entry === undefined) continue;
          const remote = await lsRemote(entry.source.git, entry.source.ref, this.opts.paths.tmpDir, this.stageOptions());
          const commitChanged = remote !== null && remote !== plugin.source.commit;
          const versionChanged = entry.version !== plugin.version;
          if (commitChanged || versionChanged) {
            out.push({
              name: plugin.name,
              current: plugin.version,
              latest: versionChanged ? entry.version : (remote?.slice(0, 7) ?? plugin.version),
            });
          }
        }
      } catch {
        // 单个插件查更新失败不影响其他插件
      }
    }
    return out;
  }

  async prepareUpdate(name: string): Promise<UpdatePreview> {
    await this.prunePending();
    const file = await loadExtensions(this.opts.paths);
    const plugin = file.plugins.find((p) => p.name === name);
    if (plugin === undefined) throw new Error(`插件不存在：${name}`);
    if (plugin.builtin) throw new Error('预装插件不能检查更新');

    let url: string;
    let ref: string | null;
    let marketPath: string | null = null;
    if (plugin.source.kind === 'git') {
      url = plugin.source.url;
      ref = plugin.source.ref;
    } else if (plugin.source.kind === 'market') {
      const market = await this.readMarket(plugin.source.marketUrl);
      const entry = market.entries.find((item) => item.name === name);
      if (entry === undefined) throw new Error(`市场里没有这个插件：${name}`);
      url = entry.source.git;
      ref = entry.source.ref ?? null;
      marketPath = entry.source.path ?? null;
    } else {
      throw new Error('这个插件不支持检查更新');
    }

    const token = randomUUID().replace(/-/g, '');
    const tempBase = path.join(this.opts.paths.tmpDir, `plugin-update-${token}`);
    await fs.mkdir(tempBase, { recursive: true });
    try {
      const commit = await stageGit(url, ref ?? undefined, tempBase, this.stageOptions());
      const newRoot = marketPath !== null && marketPath.length > 0 ? path.join(tempBase, marketPath) : tempBase;
      const source: PluginSource =
        plugin.source.kind === 'market'
          ? { kind: 'market', marketUrl: plugin.source.marketUrl, url, ref, path: marketPath, commit }
          : { kind: 'git', url, ref, commit };
      const newBundle = await readPluginBundle(newRoot);
      const target = this.pluginRoot(plugin);
      const oldBundle = (await this.tryBundle(plugin)).bundle;
      const preview = buildPreview(token, newBundle, target);
      const commandChanges = diffStdioCommands(oldBundle, newBundle, target);
      this.pendingUpdates.set(token, { tempBase, newRoot, source, name, expires: Date.now() + 30 * 60 * 1000 });
      return { ...preview, commandChanges };
    } catch (err) {
      await fs.rm(tempBase, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  async confirmUpdate(token: string): Promise<void> {
    const pending = this.pendingUpdates.get(token);
    if (pending === undefined) throw new Error('更新已取消或过期');
    const file = await loadExtensions(this.opts.paths);
    const plugin = file.plugins.find((p) => p.name === pending.name);
    if (plugin === undefined) throw new Error(`插件不存在：${pending.name}`);

    const target = this.pluginRoot(plugin);
    const backup = path.join(this.opts.paths.pluginsDir, `${pending.name}.bak-${Date.now()}`);
    const oldEntry = structuredClone(plugin);
    const newBundle = await readPluginBundle(pending.newRoot);

    let movedOld = false;
    let movedNew = false;
    try {
      for (const id of oldEntry.serverIds) await this.opts.mcp.disconnect(id).catch(() => undefined);
      await fs.mkdir(this.opts.paths.pluginsDir, { recursive: true });
      await fs.rename(target, backup);
      movedOld = true;
      await (this.opts.moveDirImpl ?? moveDir)(pending.newRoot, target);
      movedNew = true;

      plugin.version = newBundle.manifest.version;
      plugin.source = pending.source;
      plugin.serverIds = newBundle.mcp.map((draft) => pluginServerId(pending.name, draft.name));
      await saveExtensions(this.opts.paths, file);

      const values = this.valuesFor(plugin, newBundle);
      if (this.requiredComplete(newBundle, values)) {
        for (const draft of resolvePluginServers(newBundle, values)) {
          await this.opts.mcp.connect(pluginServerId(pending.name, draft.name)).catch(() => undefined);
        }
      }
      await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
    } catch (err) {
      if (movedNew) await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
      if (movedOld) await fs.rename(backup, target).catch(() => undefined);
      const restored = await loadExtensions(this.opts.paths);
      const index = restored.plugins.findIndex((p) => p.name === pending.name);
      if (index >= 0) {
        restored.plugins[index] = oldEntry;
        await saveExtensions(this.opts.paths, restored);
      }
      for (const id of oldEntry.serverIds) await this.opts.mcp.connect(id).catch(() => undefined);
      throw err;
    } finally {
      this.pendingUpdates.delete(token);
      await fs.rm(pending.tempBase, { recursive: true, force: true }).catch(() => undefined);
    }
    await this.opts.mcp.sync().catch(() => undefined);
  }

  /** 内核启动时扫描预装插件目录；已登记的保留用户配置与启用状态，版本号按资源目录更新 */
  async registerBuiltin(): Promise<void> {
    const dir = this.opts.builtinPluginsDir;
    if (dir === undefined) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const file = await loadExtensions(this.opts.paths);
    let changed = false;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const root = path.join(dir, entry.name);
      try {
        await fs.access(path.join(root, MANIFEST_FILE));
      } catch {
        continue;
      }
      let bundle: PluginBundle;
      try {
        bundle = await readPluginBundle(root);
      } catch {
        continue;
      }
      const name = bundle.manifest.name;
      const serverIds = bundle.mcp.map((draft) => pluginServerId(name, draft.name));
      const existing = file.plugins.find((p) => p.name === name);
      if (existing === undefined) {
        file.plugins.push({ name, version: bundle.manifest.version, builtin: true, source: { kind: 'builtin' }, enabled: true, serverIds });
        changed = true;
        continue;
      }
      const versionChanged = existing.version !== bundle.manifest.version;
      const idsChanged = existing.serverIds.join('\n') !== serverIds.join('\n');
      existing.builtin = true;
      existing.source = { kind: 'builtin' };
      existing.version = bundle.manifest.version;
      existing.serverIds = serverIds;
      if (versionChanged || idsChanged) changed = true;
    }
    if (changed) await saveExtensions(this.opts.paths, file);
  }

  /** 至少被一个 bot 启用、且未被该 bot 单独关掉的插件 server id */
  serverIdsInUse(bots: Bot[], plugins: InstalledPlugin[]): Set<string> {
    const byName = new Map(plugins.map((p) => [p.name, p]));
    const ids = new Set<string>();
    // 预装搜索插件不进 bot 的插件列表（由联网开关管），全局启用即保持连接
    for (const plugin of plugins) {
      if (plugin.builtin && plugin.enabled) for (const serverId of plugin.serverIds) ids.add(serverId);
    }
    for (const bot of bots) {
      for (const id of bot.extensions.mcpServers) ids.add(id);
      for (const pluginName of bot.extensions.plugins) {
        const plugin = byName.get(pluginName);
        if (plugin === undefined || !plugin.enabled) continue;
        for (const serverId of plugin.serverIds) {
          if (!bot.pluginExclusions.includes(serverId)) ids.add(serverId);
        }
      }
    }
    return ids;
  }
}
