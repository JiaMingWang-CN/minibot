import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { dataPaths, type DataPaths } from './paths.ts';
import { APPROVAL_MODES } from './config/types.ts';
import type {
  AppConfig,
  ApiFormat,
  Bot,
  BotExtensions,
  CustomModel,
  DiagnosticConsent,
  Preset,
  Provider,
  ThinkingLevel,
} from './config/types.ts';
import {
  loadBot,
  loadConfigState,
  saveBot,
  saveConfig,
  effectiveWorkspace,
  listBots,
  randomPersona,
  parseCustomModels,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from './config/config.ts';
import { allowedThinkingLevels, defaultContextWindow, findCustomModel, listPresets } from './config/presets.ts';
import { atomicWriteFile } from './fs/atomic-write.ts';
import { sha256, withPathLock } from './fs/lock.ts';
import { inTransaction, openDb } from './db/db.ts';
import {
  createThread,
  findEmptyThread,
  deleteThreadRow,
  getThread,
  listThreads,
  updateThread,
  type Thread,
} from './db/threads.ts';
import {
  appendMessage,
  deleteMessagesFrom,
  listMessages,
  messagesFrom,
  repairDanglingToolUses,
  searchMessages,
  threadUsage,
  type ListMessagesOptions,
  type SearchHit,
  type ThreadUsage,
} from './db/messages.ts';
import {
  closeDangling,
  listApprovalLog,
  logAllowlisted,
  logRequest,
  logResolved,
  markAlways,
  type ApprovalLogEntry,
} from './db/approval-log.ts';
import type { KernelEvent } from './events.ts';
import { ThreadQueue } from './agent/queue.ts';
import { ApprovalBroker, type ApprovalRequest } from './approval/broker.ts';
import { isSimpleCommand } from './approval/policy.ts';
import { runTurn, type TurnDeps, type TurnInput } from './agent/loop.ts';
import {
  compactThread,
  contextFor,
  estimateTokens,
  makePrepareContext,
} from './agent/compaction.ts';
import { buildTopicIndex } from './memory/topics.ts';
import { MemoryRevisions, type Revision } from './memory/revisions.ts';
import { Consolidator } from './memory/consolidate.ts';
import { SecretSet } from './secrets/redact.ts';
import { SecretStore, type KeyCrypto } from './secrets/store.ts';
import { ReadTracker } from './tools/read-tracker.ts';
import type { ToolEnv } from './tools/registry.ts';
import { ToolCatalog, type ExternalTool } from './tools/catalog.ts';
import { loadExtensions, saveExtensions, type WebSettings } from './extensions/store.ts';
import { WebToolProvider } from './web/web-tools.ts';
import { loadMcpServers } from './mcp/config.ts';
import { McpManager } from './mcp/manager.ts';
import { callModel as defaultCallModel, instrumentCallModel, testConnection, type CallModel } from './model/client.ts';
import { DiagLog } from './diag/log.ts';
import { ModelMetrics } from './diag/metrics.ts';
import {
  DiagnosticUploader,
  FeedbackError,
  FEEDBACK_CONTACT_MAX,
  FEEDBACK_DESCRIPTION_MAX,
  type FeedbackInput,
} from './diag/uploader.ts';
import type { Block, ImageMediaType, StoredMessage } from './model/types.ts';

export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXT: Record<ImageMediaType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BOT_ID_RE = /^[A-Za-z0-9_-]+$/;

export interface ImageInput {
  mediaType: string;
  /** base64 编码的图片数据 */
  data: string;
}

export type KernelErrorCode =
  | 'not_found'
  | 'conflict'
  | 'provider_in_use'
  | 'invalid'
  | 'key_not_persistable'
  | 'network'
  | 'rate_limited'
  | 'unavailable';

export class KernelError extends Error {
  code: KernelErrorCode;

  constructor(code: KernelErrorCode, message: string) {
    super(message);
    this.name = 'KernelError';
    this.code = code;
  }
}

function feedbackCode(kind: FeedbackError['kind']): KernelErrorCode {
  if (kind === 'rate_limited') return 'rate_limited';
  if (kind === 'network') return 'network';
  if (kind === 'rejected') return 'invalid';
  return 'unavailable';
}

function feedbackMessage(kind: FeedbackError['kind']): string {
  if (kind === 'rate_limited') return '提交太频繁，请稍后再试';
  if (kind === 'network') return '网络连接失败，请检查网络后重试';
  if (kind === 'rejected') return '反馈内容未被接受，请修改后重试';
  return '反馈服务暂不可用，请稍后再试';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === 'string');
}

function isValidExtensions(v: unknown): v is BotExtensions {
  return (
    isRecord(v) &&
    typeof v['web'] === 'boolean' &&
    isStringArray(v['plugins']) &&
    isStringArray(v['mcpServers']) &&
    isStringArray(v['skills'])
  );
}

const MCP_TOOL_KEY_RE = /^[^/]+\/.+$/;

export interface KernelState {
  onboarded: boolean;
  mainBotId: string | null;
  providers: (Provider & { hasKey: boolean })[];
  bots: Bot[];
  canPersistKeys: boolean;
  /** secrets.bin 存在但无法解密（如系统密钥库被重置），需要重新填写 Key */
  secretsUnreadable: boolean;
  /** 每个 bot 未指定工作目录时使用的默认目录（bot id → 路径） */
  defaultWorkspaces: Record<string, string>;
  /** 诊断同意状态还是 unset 且收集点可用：主界面显示一次提示条 */
  diagnosticsPrompt: boolean;
}

export interface OpenOptions {
  dataRoot: string;
  crypto: KeyCrypto;
  callModel?: CallModel;
  platform?: NodeJS.Platform;
  home?: string;
  /** 模型调用自动重试的等待时间，测试用 */
  retryDelaysMs?: number[];
  /** 应用版本号，写进 app.start 事件（桌面端传 app.getVersion()） */
  appVersion?: string;
  /** 诊断收集点地址；为空时上传与反馈整体关闭 */
  collectUrl?: string | null;
  /** 测试注入的 fetch */
  fetch?: typeof fetch;
  /** 测试注入的时钟（上传退避与指标聚合用） */
  now?: () => number;
  /** 是否启动定时上传；测试关掉后手动调用 tickDiagnostics() */
  autoUpload?: boolean;
  /** 打开系统浏览器（MCP OAuth 授权页）；桌面端传入 shell.openExternal */
  openExternal?: (url: string) => Promise<void>;
}

export interface OnboardingInput {
  providerId: string;
  model: string;
  contextWindow?: number;
  profile?: string;
  name?: string;
  persona?: string;
  workspace?: string;
}

export interface AddProviderInput {
  name: string;
  format: ApiFormat;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  presetId?: string;
  models?: CustomModel[];
}

function currentUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

function checkedModels(raw: unknown): CustomModel[] {
  try {
    return parseCustomModels(raw, true);
  } catch (err) {
    throw new KernelError('invalid', err instanceof Error ? err.message : String(err));
  }
}

export class Kernel {
  private paths: DataPaths;
  private crypto: KeyCrypto;
  private home: string;
  private platform: NodeJS.Platform;
  private callModel: CallModel;
  private db!: DatabaseSync;
  private secretSet = new SecretSet();
  private secretStore!: SecretStore;
  private config!: AppConfig;
  private queue = new ThreadQueue();
  private broker!: ApprovalBroker;
  private consolidator!: Consolidator;
  private revisions!: MemoryRevisions;
  private trackers = new Map<string, ReadTracker>();
  private listeners = new Set<(e: KernelEvent) => void>();
  private pendingJobs = new Set<Promise<void>>();
  private prepareContext!: TurnDeps['prepareContext'];
  private closed = false;
  private retryDelaysMs: number[] | undefined;
  private appVersion: string | undefined;
  private collectUrl: string | null;
  private fetchImpl: typeof fetch | undefined;
  private nowFn: () => number;
  private autoUpload: boolean;
  private openExternal: ((url: string) => Promise<void>) | undefined;
  private osName = '';
  private metrics!: ModelMetrics;
  private metricsTimer: NodeJS.Timeout | null = null;
  private uploader!: DiagnosticUploader;
  /** 本地日志与诊断事件 */
  diag!: DiagLog;
  /** MCP 连接管理；init 里创建 */
  mcp!: McpManager;
  /** 内置 + 外部工具目录；只读，后续各期在内核里注册 provider */
  readonly tools: ToolCatalog = new ToolCatalog(() => this.diag);
  /** 正在执行一轮对话的线程；此时新消息作为插话 */
  private activeTurns = new Set<string>();
  /** 线程运行中收到、还没插入的插话 */
  private steer = new Map<string, Block[][]>();

  static async open(o: OpenOptions): Promise<Kernel> {
    const kernel = new Kernel(o);
    await kernel.init();
    return kernel;
  }

  private constructor(o: OpenOptions) {
    this.paths = dataPaths(o.dataRoot);
    this.crypto = o.crypto;
    this.home = o.home ?? os.homedir();
    this.platform = o.platform ?? process.platform;
    this.callModel = o.callModel ?? defaultCallModel;
    this.retryDelaysMs = o.retryDelaysMs;
    this.appVersion = o.appVersion;
    this.collectUrl = o.collectUrl ?? null;
    this.fetchImpl = o.fetch;
    this.nowFn = o.now ?? Date.now;
    this.autoUpload = o.autoUpload ?? true;
    this.openExternal = o.openExternal;
  }

  private async init(): Promise<void> {
    await fs.mkdir(this.paths.root, { recursive: true });
    // 用真实路径作为所有比对的基准：数据目录或主目录位于链接之后时，敏感路径、记忆白名单与修订记录仍然一致
    this.paths = dataPaths(await fs.realpath(this.paths.root));
    try {
      this.home = await fs.realpath(this.home);
    } catch {
      // 主目录不存在时保持原值
    }
    this.diag = new DiagLog({
      dir: this.paths.logsDir,
      secrets: this.secretSet,
      pathContext: () => ({ home: this.home, user: currentUser(), host: os.hostname() }),
    });
    this.callModel = instrumentCallModel(this.callModel, this.diag);
    this.metrics = new ModelMetrics();
    this.callModel = this.measureCalls(this.callModel);
    this.secretStore = new SecretStore(this.paths.secrets, this.crypto, this.secretSet, {
      platform: this.platform,
    });
    await this.secretStore.load();
    const loaded = await loadConfigState(this.paths);
    this.config = loaded.config;
    if (this.config.diagnostics === undefined) {
      // 新装或配置里还没有诊断字段：先落盘，让 installId 在重启后保持不变
      this.config.diagnostics = { consent: 'unset', installId: randomUUID() };
      await saveConfig(this.paths, this.config);
    } else if (loaded.diagnosticsMigrated) {
      await saveConfig(this.paths, this.config);
    }
    await this.applyExtensionsMigration();
    this.tools.register(
      new WebToolProvider({ loadSettings: async () => (await loadExtensions(this.paths)).web }),
    );
    this.mcp = new McpManager({
      loadServers: () => loadMcpServers(this.paths),
      enabledServerIds: () => this.mcpServerIdsInUse(),
      secretStore: this.secretStore,
      emit: (e) => this.emit(e),
      home: this.home,
      platform: this.platform,
      redact: (text) => this.secretSet.redact(text),
    });
    void this.mcp.start();
    this.secretStore.registerEnv(this.envKeyNames());
    this.db = openDb(this.paths.db);
    repairDanglingToolUses(this.db);
    closeDangling(this.db);
    this.osName = `${this.platform} ${os.release()}`;
    this.uploader = new DiagnosticUploader({
      db: this.db,
      diag: this.diag,
      collectUrl: this.collectUrl,
      installId: () => this.config.diagnostics?.installId ?? '',
      consent: () => this.diagnosticsConsent(),
      platform: this.platform === 'android' ? 'android' : 'win32',
      appVersion: this.appVersion ?? '',
      os: this.osName,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      now: this.nowFn,
      autoStart: this.autoUpload,
    });
    this.uploader.start();
    this.metricsTimer = setInterval(() => this.flushMetrics(), 3600_000);
    this.metricsTimer.unref();
    this.revisions = new MemoryRevisions(this.db, this.paths);
    this.broker = new ApprovalBroker((e) => {
      // 决策日志：请求时记一行，结果出来时补上；中止导致的取消记为 system
      if (e.type === 'approval_request') logRequest(this.db, e.request);
      else logResolved(this.db, e.id, e.result, e.result === 'cancelled' ? 'system' : 'user');
      this.emit(e);
    });
    this.consolidator = new Consolidator({
      db: this.db,
      paths: this.paths,
      revisions: this.revisions,
      secrets: this.secretSet,
      callModel: this.callModel,
      resolveConsolidationModel: (bot) => this.resolveConsolidationModel(bot),
      loadBot: (id) => this.loadBotOrThrow(id),
      isThreadRunning: (id) => this.queue.isRunning(id),
      emit: (e) => this.emit(e),
    });
    this.consolidator.start();
    this.prepareContext = makePrepareContext(
      {
        db: this.db,
        callModel: this.callModel,
        resolveModel: (bot) => this.resolveModel(bot),
        emit: (e) => this.emit(e),
        secrets: this.secretSet,
      },
      (threadId) => {
        void this.consolidator.consolidateThread(threadId).catch(() => {});
      },
    );
    for (const bot of await this.bots()) this.diag.addWorkspace(effectiveWorkspace(this.paths, bot));
    const osName = this.osName;
    this.diag.write(
      'info',
      'app',
      'app.start',
      { ...(this.appVersion !== undefined ? { appVersion: this.appVersion } : {}), os: osName },
      {
        kind: 'start',
        name: 'app.start',
        data: { ...(this.appVersion !== undefined ? { appVersion: this.appVersion } : {}), os: osName },
      },
    );
  }

  /** 一次性迁移：把主 bot 的联网打开，其他 bot 保持关闭；标记写过就永不再改，用户关掉后重启不会被改回 */
  private async applyExtensionsMigration(): Promise<void> {
    if (this.config.extensionsMigrated === true) return;
    const mainBotId = this.config.mainBotId;
    if (mainBotId !== null) {
      const main = (await this.bots()).find((b) => b.id === mainBotId);
      if (main !== undefined) {
        await withPathLock(this.paths.botJson(main.id), async () => {
          const bot = await this.loadBotOrThrow(main.id);
          bot.extensions = { ...bot.extensions, web: true };
          await saveBot(this.paths, bot);
        });
      }
    }
    this.config.extensionsMigrated = true;
    await saveConfig(this.paths, this.config);
  }

  /** 把新加的扩展默认只对主 bot 启用 */
  async enableForMainBot(kind: keyof Omit<BotExtensions, 'web'>, id: string): Promise<void> {
    const mainBotId = this.config.mainBotId;
    if (mainBotId === null) return;
    await withPathLock(this.paths.botJson(mainBotId), async () => {
      const bot = await this.loadBotOrThrow(mainBotId);
      if (!bot.extensions[kind].includes(id)) bot.extensions[kind] = [...bot.extensions[kind], id];
      await saveBot(this.paths, bot);
    });
  }

  /** 卸载 / 删除扩展：从所有 bot 的启用列表里移除；删除 MCP server 时同时清掉它在 MCP 工具白名单里的条目 */
  async removeFromAllBots(kind: keyof Omit<BotExtensions, 'web'>, id: string): Promise<void> {
    for (const bot of await this.bots()) {
      await withPathLock(this.paths.botJson(bot.id), async () => {
        const current = await this.loadBotOrThrow(bot.id);
        let changed = false;
        if (current.extensions[kind].includes(id)) {
          current.extensions[kind] = current.extensions[kind].filter((x) => x !== id);
          changed = true;
        }
        const allowed =
          kind === 'mcpServers'
            ? current.allowedMcpTools.filter((key) => !key.startsWith(`${id}/`))
            : current.allowedMcpTools;
        if (allowed.length !== current.allowedMcpTools.length) {
          current.allowedMcpTools = allowed;
          changed = true;
        }
        if (changed) await saveBot(this.paths, current);
      });
    }
  }

  /** 至少一个 bot 启用的 MCP server id */
  private async mcpServerIdsInUse(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const bot of await this.bots()) {
      for (const id of bot.extensions.mcpServers) ids.add(id);
    }
    return ids;
  }

  /** 把每次模型调用的耗时与成败记入指标聚合，供每小时上报 */
  private measureCalls(inner: CallModel): CallModel {
    return async (a) => {
      const started = this.nowFn();
      const presetId = a.provider.presetId ?? a.provider.format;
      try {
        const result = await inner(a);
        this.metrics.record(presetId, a.request.model, true, this.nowFn() - started);
        return result;
      } catch (err) {
        this.metrics.record(presetId, a.request.model, false, this.nowFn() - started);
        throw err;
      }
    };
  }

  private flushMetrics(): void {
    for (const event of this.metrics.flush()) this.uploader.push(event);
  }

  /** 测试用：手动驱动一次上传检查 */
  tickDiagnostics(): Promise<void> {
    return this.uploader.tick();
  }

  private diagnosticsConsent(): DiagnosticConsent {
    return this.config.diagnostics?.consent ?? 'unset';
  }

  on(listener: (e: KernelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: KernelEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 监听器异常不影响内核
      }
    }
  }

  private findProvider(id: string): Provider | undefined {
    return this.config.providers.find((p) => p.id === id);
  }

  private providerOrThrow(id: string): Provider {
    const provider = this.findProvider(id);
    if (provider === undefined) throw new KernelError('not_found', `供应商 ${id} 不存在`);
    return provider;
  }

  private envKeyNames(): string[] {
    return this.config.providers
      .map((p) => p.apiKeyEnv)
      .filter((n): n is string => n !== undefined && n.length > 0);
  }

  /** run_command 子进程的环境：去掉供应商 Key 所在的环境变量 */
  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const names = new Set(this.envKeyNames().map((n) => (this.platform === 'win32' ? n.toUpperCase() : n)));
    for (const key of Object.keys(env)) {
      if (names.has(this.platform === 'win32' ? key.toUpperCase() : key)) delete env[key];
    }
    return env;
  }

  private keyFor(provider: Provider): string | null {
    return this.secretStore.get(provider.id, provider.apiKeyEnv);
  }

  private resolveModel(bot: Bot): { provider: Provider; apiKey: string } {
    const provider = this.providerOrThrow(bot.providerId);
    const apiKey = this.keyFor(provider);
    if (apiKey === null) throw new KernelError('invalid', '该供应商没有可用的 API Key');
    return { provider, apiKey };
  }

  private resolveConsolidationModel(bot: Bot): {
    provider: Provider;
    apiKey: string;
    model: string;
    contextWindow: number;
    maxOutputTokens: number;
  } {
    const configured = this.config.consolidationModel;
    if (configured !== null) {
      const provider = this.providerOrThrow(configured.providerId);
      const apiKey = this.keyFor(provider);
      if (apiKey === null) throw new KernelError('invalid', '后台整理供应商没有可用的 API Key');
      return {
        provider,
        apiKey,
        model: configured.model,
        contextWindow: defaultContextWindow(provider, configured.model),
        maxOutputTokens:
          findCustomModel(provider, configured.model)?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      };
    }
    const base = this.resolveModel(bot);
    return { ...base, model: bot.model, contextWindow: bot.contextWindow, maxOutputTokens: bot.maxOutputTokens };
  }

  private async loadBotOrThrow(id: string): Promise<Bot> {
    try {
      return await loadBot(this.paths, id);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new KernelError('not_found', `bot ${id} 不存在`);
      }
      throw err;
    }
  }

  async state(): Promise<KernelState> {
    const bots = await this.bots();
    return {
      onboarded:
        this.config.mainBotId !== null && bots.some((b) => b.id === this.config.mainBotId),
      mainBotId: this.config.mainBotId,
      providers: this.config.providers.map((p) => ({ ...p, hasKey: this.keyFor(p) !== null })),
      bots,
      canPersistKeys: this.secretStore.canPersist(),
      secretsUnreadable: this.secretStore.isUnreadable(),
      defaultWorkspaces: Object.fromEntries(bots.map((b) => [b.id, this.paths.defaultWorkspace(b.id)])),
      diagnosticsPrompt: this.diagnosticsConsent() === 'unset' && this.uploader.available,
    };
  }

  private async bots(): Promise<Bot[]> {
    return listBots(this.paths);
  }

  presets(): Preset[] {
    return listPresets();
  }

  /** 应用版本号（桌面端传入 app.getVersion()，未传时为空串） */
  version(): string {
    return this.appVersion ?? '';
  }

  async addProvider(i: AddProviderInput): Promise<Provider> {
    if (typeof i.name !== 'string' || i.name.trim().length === 0) {
      throw new KernelError('invalid', '供应商名称不能为空');
    }
    if (i.format !== 'chat_completions' && i.format !== 'responses' && i.format !== 'anthropic_messages') {
      throw new KernelError('invalid', '供应商格式无效');
    }
    if (typeof i.baseUrl !== 'string') throw new KernelError('invalid', 'baseUrl 必须是字符串');
    if (i.presetId !== undefined && !listPresets().some((p) => p.id === i.presetId)) {
      throw new KernelError('invalid', '预设不存在');
    }
    if (i.apiKeyEnv !== undefined && i.apiKeyEnv.length === 0) {
      throw new KernelError('invalid', '环境变量名不能为空');
    }
    if (i.apiKey !== undefined && i.apiKey.length > 0 && !this.secretStore.canPersist()) {
      throw new KernelError('key_not_persistable', '当前系统没有可用的密钥库，无法保存 API Key');
    }

    const provider: Provider = {
      id: randomUUID(),
      name: i.name,
      format: i.format,
      baseUrl: i.baseUrl,
    };
    if (i.apiKeyEnv !== undefined) provider.apiKeyEnv = i.apiKeyEnv;
    if (i.presetId !== undefined) provider.presetId = i.presetId;
    if (i.models !== undefined) provider.models = checkedModels(i.models);
    if (i.apiKey !== undefined && i.apiKey.length > 0) {
      await this.secretStore.set(provider.id, i.apiKey);
    }
    this.config.providers.push(provider);
    await saveConfig(this.paths, this.config);
    if (provider.apiKeyEnv !== undefined) this.secretStore.registerEnv([provider.apiKeyEnv]);
    return provider;
  }

  async updateProvider(
    id: string,
    patch: Partial<Omit<Provider, 'id'>> & { apiKey?: string },
  ): Promise<Provider> {
    const current = this.providerOrThrow(id);
    // 先在副本上校验并修改，全部通过后才替换；中途失败不会留下改了一半的内存状态
    const provider: Provider = { ...current };
    if (patch.name !== undefined) {
      if (patch.name.trim().length === 0) throw new KernelError('invalid', '供应商名称不能为空');
      provider.name = patch.name;
    }
    if (patch.format !== undefined) {
      if (
        patch.format !== 'chat_completions' &&
        patch.format !== 'responses' &&
        patch.format !== 'anthropic_messages'
      ) {
        throw new KernelError('invalid', '供应商格式无效');
      }
      provider.format = patch.format;
    }
    if (patch.baseUrl !== undefined) {
      if (typeof patch.baseUrl !== 'string') throw new KernelError('invalid', 'baseUrl 必须是字符串');
      provider.baseUrl = patch.baseUrl;
    }
    // 空字符串表示清除环境变量，改回使用保存的 Key
    if (patch.apiKeyEnv !== undefined) {
      if (typeof patch.apiKeyEnv !== 'string') throw new KernelError('invalid', '环境变量名必须是字符串');
      if (patch.apiKeyEnv.length === 0) delete provider.apiKeyEnv;
      else provider.apiKeyEnv = patch.apiKeyEnv;
    }
    if (patch.presetId !== undefined) {
      if (!listPresets().some((p) => p.id === patch.presetId)) {
        throw new KernelError('invalid', '预设不存在');
      }
      provider.presetId = patch.presetId;
    }
    if (patch.models !== undefined) provider.models = checkedModels(patch.models);
    const newKey = patch.apiKey !== undefined && patch.apiKey.length > 0 ? patch.apiKey : undefined;
    if (newKey !== undefined && !this.secretStore.canPersist()) {
      throw new KernelError('key_not_persistable', '当前系统没有可用的密钥库，无法保存 API Key');
    }
    if (newKey !== undefined) await this.secretStore.set(provider.id, newKey);
    if (provider.apiKeyEnv !== undefined) this.secretStore.registerEnv([provider.apiKeyEnv]);
    this.config.providers[this.config.providers.indexOf(current)] = provider;
    await saveConfig(this.paths, this.config);
    return { ...provider };
  }

  async deleteProvider(id: string): Promise<void> {
    const index = this.config.providers.findIndex((p) => p.id === id);
    if (index === -1) throw new KernelError('not_found', `供应商 ${id} 不存在`);
    const bots = await this.listBotsForUse();
    if (bots.some((b) => b.providerId === id)) {
      throw new KernelError('provider_in_use', '该供应商仍被 bot 使用');
    }
    if (this.config.consolidationModel?.providerId === id) {
      throw new KernelError('provider_in_use', '该供应商仍被后台整理使用');
    }
    this.config.providers.splice(index, 1);
    await this.secretStore.delete(id);
    await saveConfig(this.paths, this.config);
  }

  private async listBotsForUse(): Promise<Bot[]> {
    return this.bots();
  }

  testProvider(id: string, model: string): ReturnType<typeof testConnection> {
    const provider = this.providerOrThrow(id);
    const apiKey = this.keyFor(provider);
    if (apiKey === null) {
      return Promise.resolve({
        ok: false,
        kind: 'auth',
        message: '该供应商没有配置 API Key',
      });
    }
    return testConnection(provider, apiKey, model);
  }

  async completeOnboarding(i: OnboardingInput): Promise<Bot> {
    if (this.config.mainBotId !== null) throw new KernelError('invalid', '已经完成初始化');
    const provider = this.providerOrThrow(i.providerId);
    const picked = randomPersona();
    const bot: Bot = {
      schemaVersion: 1,
      id: randomUUID(),
      name: i.name !== undefined && i.name.trim().length > 0 ? i.name.trim() : picked.name,
      persona:
        i.persona !== undefined && i.persona.trim().length > 0 ? i.persona.trim() : picked.persona,
      providerId: provider.id,
      model: i.model,
      contextWindow: i.contextWindow ?? defaultContextWindow(provider, i.model),
      maxOutputTokens:
        provider.models?.find((m) => m.id === i.model)?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      workspace: i.workspace !== undefined && i.workspace.trim().length > 0 ? i.workspace.trim() : null,
      approvalMode: 'ask',
      thinkingLevel: null,
      allowedCommands: [],
      extensions: { web: true, plugins: [], mcpServers: [], skills: [] },
      allowWeb: false,
      allowedMcpTools: [],
      memoryEnabled: true,
    };
    const workspace = effectiveWorkspace(this.paths, bot);
    this.diag.addWorkspace(workspace);
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(this.paths.memoryDir(bot.id), { recursive: true });
    if (i.profile !== undefined && i.profile.length > 0) {
      await atomicWriteFile(this.paths.userMd, i.profile);
    }
    await saveBot(this.paths, bot);
    this.config.mainBotId = bot.id;
    await saveConfig(this.paths, this.config);
    return bot;
  }

  async updateBot(
    id: string,
    patch: Partial<
      Pick<
        Bot,
        | 'name'
        | 'persona'
        | 'providerId'
        | 'model'
        | 'contextWindow'
        | 'maxOutputTokens'
        | 'workspace'
        | 'approvalMode'
        | 'thinkingLevel'
        | 'allowedCommands'
        | 'extensions'
        | 'allowWeb'
        | 'allowedMcpTools'
        | 'memoryEnabled'
      >
    >,
  ): Promise<Bot> {
    return withPathLock(this.paths.botJson(id), () => this.updateBotLocked(id, patch));
  }

  private async updateBotLocked(id: string, patch: Parameters<Kernel['updateBot']>[1]): Promise<Bot> {
    const bot = await this.loadBotOrThrow(id);
    if (patch.allowedCommands !== undefined) {
      if (
        !Array.isArray(patch.allowedCommands) ||
        !patch.allowedCommands.every((c) => typeof c === 'string' && isSimpleCommand(c))
      ) {
        throw new KernelError('invalid', '“总是允许”只能是不含管道、重定向、变量等的单条命令');
      }
      bot.allowedCommands = [...new Set(patch.allowedCommands)];
    }
    if (patch.extensions !== undefined) {
      if (!isValidExtensions(patch.extensions)) {
        throw new KernelError('invalid', 'extensions 格式无效');
      }
      bot.extensions = {
        web: patch.extensions.web,
        plugins: [...new Set(patch.extensions.plugins)],
        mcpServers: [...new Set(patch.extensions.mcpServers)],
        skills: [...new Set(patch.extensions.skills)],
      };
    }
    if (patch.allowWeb !== undefined) {
      if (typeof patch.allowWeb !== 'boolean') throw new KernelError('invalid', 'allowWeb 必须是布尔值');
      bot.allowWeb = patch.allowWeb;
    }
    if (patch.allowedMcpTools !== undefined) {
      if (
        !Array.isArray(patch.allowedMcpTools) ||
        !patch.allowedMcpTools.every((key) => typeof key === 'string' && MCP_TOOL_KEY_RE.test(key))
      ) {
        throw new KernelError('invalid', 'allowedMcpTools 格式无效');
      }
      bot.allowedMcpTools = [...new Set(patch.allowedMcpTools)];
    }
    if (patch.memoryEnabled !== undefined) {
      if (typeof patch.memoryEnabled !== 'boolean') throw new KernelError('invalid', 'memoryEnabled 必须是布尔值');
      bot.memoryEnabled = patch.memoryEnabled;
    }
    for (const key of ['name', 'persona', 'providerId', 'model'] as const) {
      const value: unknown = patch[key];
      if (value !== undefined && typeof value !== 'string') {
        throw new KernelError('invalid', `${key} 必须是字符串`);
      }
    }
    if (patch.name !== undefined) bot.name = patch.name;
    if (patch.persona !== undefined) bot.persona = patch.persona;
    if (patch.providerId !== undefined) bot.providerId = patch.providerId;
    if (patch.model !== undefined) bot.model = patch.model;
    if (patch.workspace !== undefined) {
      const workspace: unknown = patch.workspace;
      if (workspace !== null && (typeof workspace !== 'string' || !path.isAbsolute(workspace))) {
        throw new KernelError('invalid', '工作目录必须是绝对路径');
      }
      bot.workspace = patch.workspace;
    }
    if (patch.approvalMode !== undefined) {
      if (!APPROVAL_MODES.includes(patch.approvalMode)) {
        throw new KernelError('invalid', '审批模式无效');
      }
      bot.approvalMode = patch.approvalMode;
    }
    if (patch.contextWindow !== undefined) {
      if (!Number.isFinite(patch.contextWindow) || patch.contextWindow <= 0) {
        throw new KernelError('invalid', '上下文窗口必须是正数');
      }
      bot.contextWindow = patch.contextWindow;
    }
    if (patch.maxOutputTokens !== undefined) {
      if (!Number.isFinite(patch.maxOutputTokens) || patch.maxOutputTokens <= 0) {
        throw new KernelError('invalid', '输出上限必须是正数');
      }
      bot.maxOutputTokens = patch.maxOutputTokens;
    }

    const provider = this.providerOrThrow(bot.providerId);
    const allowed = allowedThinkingLevels(provider, bot.model);
    if (patch.thinkingLevel !== undefined) {
      if (patch.thinkingLevel !== null && !allowed.includes(patch.thinkingLevel)) {
        throw new KernelError('invalid', '该模型不支持所选的思考档位');
      }
      bot.thinkingLevel = patch.thinkingLevel as ThinkingLevel | null;
    } else if (bot.thinkingLevel !== null && !allowed.includes(bot.thinkingLevel)) {
      bot.thinkingLevel = null;
    }

    this.diag.addWorkspace(effectiveWorkspace(this.paths, bot));
    await saveBot(this.paths, bot);
    return bot;
  }

  listThreads(botId: string): Thread[] {
    return listThreads(this.db, botId);
  }

  createThread(botId: string): Thread {
    // 已有空对话就直接用它，避免无限新建空对话
    return findEmptyThread(this.db, botId) ?? createThread(this.db, botId, '新对话');
  }

  /** 单个对话的信息（手机端通知用它取标题和所属 bot） */
  thread(threadId: string): Thread {
    return this.threadOrThrow(threadId);
  }

  private threadOrThrow(threadId: string): Thread {
    const thread = getThread(this.db, threadId);
    if (thread === null) throw new KernelError('not_found', '线程不存在');
    return thread;
  }

  renameThread(threadId: string, title: string): Thread {
    this.threadOrThrow(threadId);
    const trimmed = typeof title === 'string' ? title.trim() : '';
    if (trimmed.length === 0) throw new KernelError('invalid', '线程名称不能为空');
    if ([...trimmed].length > 100) throw new KernelError('invalid', '线程名称不能超过 100 个字');
    updateThread(this.db, threadId, { title: trimmed });
    return this.threadOrThrow(threadId);
  }

  /** 删除线程：先中止正在运行与排队的任务（含待审批），等它们结束后删消息、线程与图片附件 */
  async deleteThread(threadId: string): Promise<void> {
    this.threadOrThrow(threadId);
    this.steer.delete(threadId);
    this.queue.abortThread(threadId);
    await this.queue.whenIdle(threadId);
    this.steer.delete(threadId);
    if (getThread(this.db, threadId) === null) return;
    // 删消息与删线程行在一个事务里；deleteMessagesFrom 发现已在事务中会直接执行
    const removed = inTransaction(this.db, () => {
      const messages = deleteMessagesFrom(this.db, threadId, 0);
      deleteThreadRow(this.db, threadId);
      return messages;
    });
    this.trackers.delete(threadId);
    await this.removeAttachments(removed);
    this.emit({ type: 'thread_deleted', threadId });
  }

  listMessages(threadId: string, before?: number, limit?: number): StoredMessage[] {
    if (before !== undefined && !Number.isInteger(before)) throw new KernelError('invalid', 'before 必须是整数');
    // 小数取整；-1 在 SQLite 里等于不限，所以夹到 1–200
    const size = limit === undefined || !Number.isFinite(limit) ? 50 : Math.min(Math.max(Math.floor(limit), 1), 200);
    const options: ListMessagesOptions = { limit: size };
    if (before !== undefined) options.before = before;
    return listMessages(this.db, threadId, options);
  }

  threadUsage(threadId: string): ThreadUsage {
    this.threadOrThrow(threadId);
    return threadUsage(this.db, threadId);
  }

  search(query: string, opts: { botId?: string; limit?: number } = {}): SearchHit[] {
    const q = typeof query === 'string' ? query.trim() : '';
    if (q.length === 0) throw new KernelError('invalid', '搜索内容不能为空');
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 200);
    return searchMessages(this.db, q, { limit, ...(opts.botId !== undefined ? { botId: opts.botId } : {}) });
  }

  /**
   * 发消息。线程正在执行一轮时作为插话：在下一次工具结果之后（或模型本要结束时）插入本轮，返回 'steer'；
   * 否则开始新的一轮，返回 'turn'。
   */
  sendMessage(threadId: string, text: string, images: ImageInput[] = []): 'turn' | 'steer' {
    this.threadOrThrow(threadId);
    if (typeof text !== 'string') throw new KernelError('invalid', 'text 必须是字符串');
    if (!Array.isArray(images)) throw new KernelError('invalid', 'images 必须是数组');
    if (text.trim().length === 0 && images.length === 0) throw new KernelError('invalid', '消息不能为空');
    const blocks: Block[] = [];
    if (text.length > 0) blocks.push({ type: 'text', text });
    blocks.push(...this.saveImages(images));
    if (this.activeTurns.has(threadId)) {
      const list = this.steer.get(threadId) ?? [];
      list.push(blocks);
      this.steer.set(threadId, list);
      return 'steer';
    }
    this.enqueueTurn(threadId, { blocks });
    return 'turn';
  }

  /** 手动重试：删掉最后一轮用户消息之后的全部内容，用这条用户消息重跑 */
  retry(threadId: string): void {
    const thread = this.threadOrThrow(threadId);
    if (this.queue.isRunning(threadId) || this.activeTurns.has(threadId)) {
      throw new KernelError('conflict', '线程正在运行');
    }
    const start = messagesFrom(this.db, threadId, 0)
      .filter(
        (m) =>
          m.role === 'user' &&
          m.kind === null &&
          m.blocks.length > 0 &&
          m.blocks.every((b) => b.type === 'text' || b.type === 'image'),
      )
      .at(-1);
    if (start === undefined) throw new KernelError('invalid', '没有可以重试的消息');
    if ((thread.summaryMsgId !== null && thread.summaryMsgId > start.id) || thread.keepFromMsgId > start.id) {
      throw new KernelError('invalid', '这一轮之后压缩过上下文，无法重试');
    }
    const removed = deleteMessagesFrom(this.db, threadId, start.id + 1);
    const patch: Parameters<typeof updateThread>[2] = {};
    if (thread.lastInputMsgId !== null && thread.lastInputMsgId > start.id) {
      patch.lastInputTokens = null;
      patch.lastInputMsgId = null;
    }
    if (thread.lastExtractedMsgId > start.id) patch.lastExtractedMsgId = start.id;
    updateThread(this.db, threadId, patch);
    void this.removeAttachments(removed);
    this.emit({ type: 'messages_deleted', threadId, fromId: start.id + 1 });
    this.enqueueTurn(threadId, { resumeFromId: start.id });
  }

  private enqueueTurn(threadId: string, input: TurnInput): void {
    const job = this.queue.enqueue(threadId, async (signal) => {
      const thread = getThread(this.db, threadId);
      if (thread === null) return;
      const bot = await this.loadBotOrThrow(thread.botId);
      this.activeTurns.add(threadId);
      try {
        await runTurn(
          {
            db: this.db,
            callModel: this.callModel,
            emit: (e) => this.emit(e),
            resolveModel: (b) => this.resolveModel(b),
            makeToolEnv: (b, id, s) => this.makeToolEnv(b, id, s),
            snapshotTools: (b) => this.tools.snapshot(b),
            prepareContext: this.prepareContext,
            takeSteer: (id) => {
              const items = this.steer.get(id) ?? [];
              this.steer.delete(id);
              return items;
            },
            loadAttachments: (ids) => this.loadAttachments(ids),
            ...(this.retryDelaysMs !== undefined ? { retryDelaysMs: this.retryDelaysMs } : {}),
          },
          bot,
          threadId,
          input,
          signal,
        );
      } finally {
        // 本轮结束（含中止）时还没插入的插话，合成一条消息作为新的一轮
        this.activeTurns.delete(threadId);
        const left = this.steer.get(threadId) ?? [];
        this.steer.delete(threadId);
        if (left.length > 0 && !this.closed && getThread(this.db, threadId) !== null) {
          this.enqueueTurn(threadId, { blocks: left.flat() });
        }
      }
    });
    const tracked = job
      .catch(() => {})
      .finally(() => {
        this.pendingJobs.delete(tracked);
      });
    this.pendingJobs.add(tracked);
  }

  private saveImages(images: ImageInput[]): Block[] {
    if (images.length > MAX_IMAGES_PER_MESSAGE) {
      throw new KernelError('invalid', `每条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片`);
    }
    const decoded = images.map((image) => {
      if (typeof image !== 'object' || image === null || !(image.mediaType in IMAGE_EXT)) {
        throw new KernelError('invalid', '图片格式只支持 PNG、JPEG、GIF、WebP');
      }
      if (typeof image.data !== 'string' || image.data.length % 4 !== 0 || !BASE64_RE.test(image.data)) {
        throw new KernelError('invalid', '图片数据不是有效的 base64');
      }
      const data = Buffer.from(image.data, 'base64');
      if (data.length > MAX_IMAGE_BYTES) throw new KernelError('invalid', '单张图片不能超过 5MB');
      return { mediaType: image.mediaType as ImageMediaType, data };
    });
    if (decoded.length === 0) return [];
    mkdirSync(this.paths.attachments, { recursive: true });
    return decoded.map(({ mediaType, data }) => {
      const id = randomUUID();
      writeFileSync(path.join(this.paths.attachments, `${id}${IMAGE_EXT[mediaType]}`), data);
      return { type: 'image', id, mediaType };
    });
  }

  private attachmentPath(id: string): { file: string; mediaType: ImageMediaType } | null {
    for (const [mediaType, ext] of Object.entries(IMAGE_EXT) as [ImageMediaType, string][]) {
      const file = path.join(this.paths.attachments, `${id}${ext}`);
      if (existsSync(file)) return { file, mediaType };
    }
    return null;
  }

  async readAttachment(id: string): Promise<{ mediaType: ImageMediaType; data: Buffer }> {
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw new KernelError('invalid', '附件 id 无效');
    const found = this.attachmentPath(id);
    if (found === null) throw new KernelError('not_found', '附件不存在');
    return { mediaType: found.mediaType, data: await fs.readFile(found.file) };
  }

  private async loadAttachments(ids: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const id of new Set(ids)) {
      if (!UUID_RE.test(id)) continue;
      const found = this.attachmentPath(id);
      if (found === null) continue;
      try {
        out[id] = (await fs.readFile(found.file)).toString('base64');
      } catch {
        // 读不到的图片由适配器换成文字占位
      }
    }
    return out;
  }

  private async removeAttachments(messages: StoredMessage[]): Promise<void> {
    for (const message of messages) {
      for (const block of message.blocks) {
        if (block.type !== 'image' || !UUID_RE.test(block.id)) continue;
        const found = this.attachmentPath(block.id);
        if (found !== null) await fs.rm(found.file, { force: true });
      }
    }
  }

  /** bot 的记忆目录（桌面端用它在文件管理器里打开） */
  memoryDir(botId: string): string {
    if (typeof botId !== 'string' || !BOT_ID_RE.test(botId) || !existsSync(this.paths.botJson(botId))) {
      throw new KernelError('not_found', `bot ${String(botId)} 不存在`);
    }
    const dir = this.paths.memoryDir(botId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  approvalLog(opts: { botId?: string; before?: number; limit?: number }): ApprovalLogEntry[] {
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 100), 1), 500);
    return listApprovalLog(this.db, {
      limit,
      ...(opts.botId !== undefined ? { botId: opts.botId } : {}),
      ...(opts.before !== undefined ? { before: opts.before } : {}),
    });
  }

  private makeToolEnv(bot: Bot, threadId: string, signal: AbortSignal): ToolEnv {
    let tracker = this.trackers.get(threadId);
    if (tracker === undefined) {
      tracker = new ReadTracker();
      this.trackers.set(threadId, tracker);
    }
    const provider = this.findProvider(bot.providerId);
    const supportsImages = provider === undefined ? true : (findCustomModel(provider, bot.model)?.vision ?? true);
    return {
      bot,
      threadId,
      workspace: effectiveWorkspace(this.paths, bot),
      paths: this.paths,
      home: this.home,
      tracker,
      secrets: this.secretSet,
      revisions: this.revisions,
      broker: this.broker,
      signal,
      supportsImages,
      childEnv: this.childEnv(),
      // 读最新配置：本轮中途刚勾选“总是允许”的命令也能生效
      // 与“总是允许”的保存共用同一把锁，排在保存之后读，批准后紧接着的同一条命令不会重复询问
      isCommandAllowed: (command) =>
        withPathLock(this.paths.botJson(bot.id), async () =>
          (await this.loadBotOrThrow(bot.id)).allowedCommands.includes(command),
        ),
      isExternalAllowed: (tool: ExternalTool) =>
        withPathLock(this.paths.botJson(bot.id), async () => {
          const latest = await this.loadBotOrThrow(bot.id);
          if (tool.source.kind === 'web') return latest.allowWeb === true;
          return latest.allowedMcpTools.includes(`${tool.source.serverId}/${tool.source.toolName}`);
        }),
      onAllowlisted: (request) => logAllowlisted(this.db, request),
      diag: this.diag,
    };
  }

  /** 线程当前上下文占用（token）。有上一轮的真实用量作基线时在其上累加新消息，否则按字符估算。 */
  async contextUsage(threadId: string): Promise<{ tokens: number; window: number }> {
    const thread = getThread(this.db, threadId);
    if (thread === null) throw new KernelError('not_found', `线程 ${threadId} 不存在`);
    const bot = await this.loadBotOrThrow(thread.botId);
    const basis =
      thread.lastInputTokens !== null && thread.lastInputMsgId !== null
        ? { inputTokens: thread.lastInputTokens, upToMsgId: thread.lastInputMsgId }
        : undefined;
    const context = contextFor(this.db, threadId);
    return {
      tokens: context.length === 0 ? 0 : estimateTokens('', context, basis),
      window: bot.contextWindow,
    };
  }

  abort(threadId: string): void {
    this.queue.abort(threadId);
  }

  compact(threadId: string): void {
    const thread = getThread(this.db, threadId);
    if (thread === null) return;
    // 走线程队列：完整压缩只在两轮之间进行，不与正在进行的一轮并发
    const job = this.queue.enqueue(threadId, async (signal) => {
      try {
        const bot = await this.loadBotOrThrow(thread.botId);
        const compacted = await compactThread(
          {
            db: this.db,
            callModel: this.callModel,
            resolveModel: (b) => this.resolveModel(b),
            emit: (e) => this.emit(e),
            secrets: this.secretSet,
          },
          bot,
          threadId,
          'auto',
          signal,
        );
        if (!compacted) {
          // 点了压缩却没有任何反应会让人以为坏了
          const notice = appendMessage(this.db, {
            threadId,
            role: 'user',
            blocks: [{ type: 'text', text: '对话还很短，没有需要压缩的内容。' }],
            kind: 'notice',
            interrupted: false,
          });
          this.emit({ type: 'message', threadId, message: notice });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const notice = appendMessage(this.db, {
          threadId,
          role: 'user',
          blocks: [{ type: 'text', text: `压缩失败：${this.secretSet.redact(message)}` }],
          kind: 'notice',
          interrupted: false,
        });
        this.emit({ type: 'message', threadId, message: notice });
      }
    });
    const tracked = job
      .catch(() => {})
      .finally(() => {
        this.pendingJobs.delete(tracked);
      });
    this.pendingJobs.add(tracked);
  }

  /** always：批准时勾选“总是允许”，按 alwaysKind 写入命令 / 联网 / 单个 MCP 工具的白名单 */
  respondApproval(id: string, approve: boolean, always = false): boolean {
    const request = this.broker.get(id);
    const ok = this.broker.respond(id, approve);
    if (ok && approve && always && request?.canAlwaysAllow === true) {
      const kind = request.alwaysKind ?? (request.command !== undefined ? 'command' : undefined);
      if (kind !== undefined) {
        markAlways(this.db, id);
        const saving = withPathLock(this.paths.botJson(request.botId), async () => {
          const bot = await this.loadBotOrThrow(request.botId);
          if (kind === 'command') {
            const command = request.command;
            if (command === undefined || bot.allowedCommands.includes(command)) return;
            bot.allowedCommands = [...bot.allowedCommands, command];
          } else if (kind === 'web') {
            if (bot.allowWeb) return;
            bot.allowWeb = true;
          } else {
            const key = request.mcpToolKey;
            if (key === undefined || bot.allowedMcpTools.includes(key)) return;
            bot.allowedMcpTools = [...bot.allowedMcpTools, key];
          }
          await saveBot(this.paths, bot);
        });
        const tracked = saving
          .catch(() => {})
          .finally(() => {
            this.pendingJobs.delete(tracked);
          });
        this.pendingJobs.add(tracked);
      }
    }
    return ok;
  }

  /** 正在运行（含刚开始、还没进队列）的线程；界面重连或重载后据此恢复运行状态 */
  runningThreads(): string[] {
    return [...new Set([...this.activeTurns, ...this.queue.runningIds()])];
  }

  pendingApprovals(): ApprovalRequest[] {
    return this.broker.pending();
  }

  async listMemory(
    botId: string,
  ): Promise<{ user: { path: string }; topics: { name: string; summary: string | null; path: string }[] }> {
    const bot = await this.loadBotOrThrow(botId);
    const topics = await buildTopicIndex(this.paths.memoryDir(bot.id));
    return {
      user: { path: this.paths.userMd },
      topics: topics.map((t) => ({ name: t.name, summary: t.summary, path: t.path })),
    };
  }

  async readMemoryFile(filePath: string): Promise<{ content: string; hash: string }> {
    const real = path.resolve(filePath);
    if (!this.revisions.isTracked(real)) {
      throw new KernelError('invalid', '只能读取记忆文件');
    }
    let content: string;
    try {
      content = await fs.readFile(real, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new KernelError('not_found', '文件不存在');
      }
      throw err;
    }
    return { content, hash: sha256(content) };
  }

  async writeMemoryFile(
    filePath: string,
    content: string,
    baseHash: string,
  ): Promise<{ hash: string }> {
    const real = path.resolve(filePath);
    if (!this.revisions.isTracked(real)) {
      throw new KernelError('invalid', '只能写入记忆文件');
    }
    if (this.secretSet.containsKnown(content)) {
      throw new KernelError('invalid', '记忆与用户画像中不得包含 API Key。');
    }
    return withPathLock(real, async () => {
      const current = await this.readTextOrEmpty(real);
      if (sha256(current) !== baseHash) {
        throw new KernelError('conflict', '文件已被修改，请重新加载');
      }
      const hash = sha256(content);
      await this.revisions.write(real, content, 'user', 'manual_ui');
      this.emit({ type: 'memory_changed', path: real });
      return { hash };
    });
  }

  private async readTextOrEmpty(file: string): Promise<string> {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  }

  listRevisions(filePath: string): Revision[] {
    const real = path.resolve(filePath);
    if (!this.revisions.isTracked(real)) throw new KernelError('invalid', '只能查看记忆文件的修订');
    return this.revisions.list(real);
  }

  async revert(revisionId: number): Promise<void> {
    const row = this.db.prepare('SELECT * FROM memory_revisions WHERE id = ?').get(revisionId);
    if (row === undefined) throw new KernelError('not_found', '修订不存在');
    const filePath = (row as Record<string, unknown>)['file_path'] as string;
    await this.revisions.revert(revisionId);
    this.emit({ type: 'memory_changed', path: filePath });
  }

  settings(): { consolidationModel: AppConfig['consolidationModel'] } {
    return { consolidationModel: this.config.consolidationModel };
  }

  async webSettings(): Promise<WebSettings> {
    return (await loadExtensions(this.paths)).web;
  }

  /** 本期只支持网页抓取开关；搜索引擎只能是 none，第 4 期再开放 */
  async updateWebSettings(patch: { fetchEnabled?: boolean; searchEngine?: WebSettings['searchEngine'] }): Promise<WebSettings> {
    // 读改写在同一把锁里，桌面和手机同时修改不丢更新
    return withPathLock(this.paths.extensionsJson, async () => {
      const file = await loadExtensions(this.paths);
      if (patch.fetchEnabled !== undefined) {
        if (typeof patch.fetchEnabled !== 'boolean') throw new KernelError('invalid', 'fetchEnabled 必须是布尔值');
        file.web.fetchEnabled = patch.fetchEnabled;
      }
      if (patch.searchEngine !== undefined) {
        if (patch.searchEngine !== 'none') throw new KernelError('invalid', '搜索引擎不可用');
        file.web.searchEngine = 'none';
      }
      await saveExtensions(this.paths, file);
      return file.web;
    });
  }

  async updateSettings(s: { consolidationModel: AppConfig['consolidationModel'] }): Promise<void> {
    if (s.consolidationModel !== null && this.findProvider(s.consolidationModel.providerId) === undefined) {
      throw new KernelError('invalid', '后台整理供应商不存在');
    }
    this.config.consolidationModel = s.consolidationModel;
    await saveConfig(this.paths, this.config);
  }

  // —— 诊断与反馈 ——

  diagnostics(): { consent: DiagnosticConsent; available: boolean; appVersion: string } {
    return {
      consent: this.diagnosticsConsent(),
      available: this.uploader.available,
      appVersion: this.appVersion ?? '',
    };
  }

  async setDiagnostics(consent: 'on' | 'off'): Promise<void> {
    const diagnostics = this.config.diagnostics;
    if (diagnostics === undefined) throw new KernelError('invalid', '诊断配置缺失');
    diagnostics.consent = consent;
    await saveConfig(this.paths, this.config);
    // off 立即清空队列；on 立即尝试上传一次
    this.uploader.setConsent(consent);
  }

  async logsPreview(): Promise<{ text: string }> {
    // 预览后提交时用同一份内容
    return { text: await this.uploader.previewLogs() };
  }

  async sendFeedback(input: FeedbackInput): Promise<{ ok: true }> {
    if (!this.uploader.available) throw new KernelError('not_found', '反馈功能未开启');
    if (typeof input.description !== 'string' || input.description.trim().length === 0) {
      throw new KernelError('invalid', '问题描述不能为空');
    }
    if (input.description.length > FEEDBACK_DESCRIPTION_MAX) {
      throw new KernelError('invalid', `问题描述不能超过 ${FEEDBACK_DESCRIPTION_MAX} 字`);
    }
    if (input.contact !== undefined && input.contact.length > FEEDBACK_CONTACT_MAX) {
      throw new KernelError('invalid', `联系方式不能超过 ${FEEDBACK_CONTACT_MAX} 字`);
    }
    try {
      await this.uploader.sendFeedback(input);
    } catch (err) {
      if (err instanceof FeedbackError) throw new KernelError(feedbackCode(err.kind), feedbackMessage(err.kind));
      throw err;
    }
    return { ok: true };
  }

  /** 渲染端未捕获错误：消息只进完整日志，事件只带脱敏堆栈 */
  reportClientError(input: { message: string; stack?: string; source?: string }): { ok: true } {
    const message = typeof input.message === 'string' ? input.message : '';
    const stack = typeof input.stack === 'string' && input.stack.length > 0 ? this.diag.scrubStack(input.stack) : undefined;
    this.diag.write(
      'error',
      'app',
      'renderer.error',
      { message, ...(stack !== undefined ? { stack } : {}) },
      {
        kind: 'crash',
        name: 'crash/renderer',
        data: { source: 'renderer', ...(stack !== undefined ? { stack } : {}) },
      },
    );
    return { ok: true };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.metricsTimer !== null) clearInterval(this.metricsTimer);
    this.metricsTimer = null;
    this.uploader.close();
    this.queue.abortAll();
    await Promise.allSettled([...this.pendingJobs]);
    await this.mcp.stop();
    // 整理在数据库关闭后还可能写记忆文件：先中止并等它结束
    await this.consolidator.stop();
    this.db.close();
    await this.diag.close();
  }
}
