import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { dataPaths, type DataPaths } from './paths.ts';
import { APPROVAL_MODES } from './config/types.ts';
import type { AppConfig, ApiFormat, Bot, Preset, Provider, ThinkingLevel } from './config/types.ts';
import {
  loadBot,
  loadConfig,
  saveBot,
  saveConfig,
  effectiveWorkspace,
  listBots,
  randomPersona,
} from './config/config.ts';
import { allowedThinkingLevels, defaultContextWindow, listPresets } from './config/presets.ts';
import { atomicWriteFile } from './fs/atomic-write.ts';
import { sha256, withPathLock } from './fs/lock.ts';
import { openDb } from './db/db.ts';
import {
  createThread,
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
import { callModel as defaultCallModel, testConnection, type CallModel } from './model/client.ts';
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
  | 'key_not_persistable';

export class KernelError extends Error {
  code: KernelErrorCode;

  constructor(code: KernelErrorCode, message: string) {
    super(message);
    this.name = 'KernelError';
    this.code = code;
  }
}

export interface KernelState {
  onboarded: boolean;
  mainBotId: string | null;
  providers: (Provider & { hasKey: boolean })[];
  bots: Bot[];
  canPersistKeys: boolean;
  /** secrets.bin 存在但无法解密（如系统密钥库被重置），需要重新填写 Key */
  secretsUnreadable: boolean;
}

export interface OpenOptions {
  dataRoot: string;
  crypto: KeyCrypto;
  callModel?: CallModel;
  platform?: NodeJS.Platform;
  home?: string;
  /** 模型调用自动重试的等待时间，测试用 */
  retryDelaysMs?: number[];
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
    this.secretStore = new SecretStore(this.paths.secrets, this.crypto, this.secretSet, {
      platform: this.platform,
    });
    await this.secretStore.load();
    this.config = await loadConfig(this.paths);
    this.secretStore.registerEnv(this.envKeyNames());
    this.db = openDb(this.paths.db);
    repairDanglingToolUses(this.db);
    closeDangling(this.db);
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
  } {
    const configured = this.config.consolidationModel;
    if (configured !== null) {
      const provider = this.providerOrThrow(configured.providerId);
      const apiKey = this.keyFor(provider);
      if (apiKey === null) throw new KernelError('invalid', '后台整理供应商没有可用的 API Key');
      return { provider, apiKey, model: configured.model };
    }
    const base = this.resolveModel(bot);
    return { ...base, model: bot.model };
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
    };
  }

  private async bots(): Promise<Bot[]> {
    return listBots(this.paths);
  }

  presets(): Preset[] {
    return listPresets();
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
    const provider = this.providerOrThrow(id);
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
    if (patch.apiKeyEnv !== undefined) {
      if (patch.apiKeyEnv.length === 0) throw new KernelError('invalid', '环境变量名不能为空');
      provider.apiKeyEnv = patch.apiKeyEnv;
      this.secretStore.registerEnv([patch.apiKeyEnv]);
    }
    if (patch.presetId !== undefined) {
      if (!listPresets().some((p) => p.id === patch.presetId)) {
        throw new KernelError('invalid', '预设不存在');
      }
      provider.presetId = patch.presetId;
    }
    if (patch.apiKey !== undefined && patch.apiKey.length > 0) {
      if (!this.secretStore.canPersist()) {
        throw new KernelError('key_not_persistable', '当前系统没有可用的密钥库，无法保存 API Key');
      }
      await this.secretStore.set(provider.id, patch.apiKey);
    }
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
      maxOutputTokens: 128_000,
      workspace: i.workspace !== undefined && i.workspace.trim().length > 0 ? i.workspace.trim() : null,
      approvalMode: 'ask',
      thinkingLevel: null,
      allowedCommands: [],
      memoryEnabled: true,
    };
    const workspace = effectiveWorkspace(this.paths, bot);
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
    if (patch.memoryEnabled !== undefined) {
      if (typeof patch.memoryEnabled !== 'boolean') throw new KernelError('invalid', 'memoryEnabled 必须是布尔值');
      bot.memoryEnabled = patch.memoryEnabled;
    }
    if (patch.name !== undefined) bot.name = patch.name;
    if (patch.persona !== undefined) bot.persona = patch.persona;
    if (patch.providerId !== undefined) bot.providerId = patch.providerId;
    if (patch.model !== undefined) bot.model = patch.model;
    if (patch.workspace !== undefined) bot.workspace = patch.workspace;
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

    await saveBot(this.paths, bot);
    return bot;
  }

  listThreads(botId: string): Thread[] {
    return listThreads(this.db, botId);
  }

  createThread(botId: string): Thread {
    return createThread(this.db, botId, '新对话');
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
    const removed = deleteMessagesFrom(this.db, threadId, 0);
    deleteThreadRow(this.db, threadId);
    this.trackers.delete(threadId);
    await this.removeAttachments(removed);
    this.emit({ type: 'thread_deleted', threadId });
  }

  listMessages(threadId: string, before?: number, limit?: number): StoredMessage[] {
    const options: ListMessagesOptions = { limit: limit ?? 50 };
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
      childEnv: this.childEnv(),
      // 读最新配置：本轮中途刚勾选“总是允许”的命令也能生效
      isCommandAllowed: async (command) => (await this.loadBotOrThrow(bot.id)).allowedCommands.includes(command),
      onAllowlisted: (request) => logAllowlisted(this.db, request),
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
        await compactThread(
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

  /** always：批准时“总是允许此命令”，只对可以加入白名单的简单命令生效 */
  respondApproval(id: string, approve: boolean, always = false): boolean {
    const request = this.broker.get(id);
    const ok = this.broker.respond(id, approve);
    if (ok && approve && always && request?.canAlwaysAllow === true && request.command !== undefined) {
      markAlways(this.db, id);
      const command = request.command;
      const saving = withPathLock(this.paths.botJson(request.botId), async () => {
        const bot = await this.loadBotOrThrow(request.botId);
        if (bot.allowedCommands.includes(command)) return;
        bot.allowedCommands = [...bot.allowedCommands, command];
        await saveBot(this.paths, bot);
      });
      const tracked = saving
        .catch(() => {})
        .finally(() => {
          this.pendingJobs.delete(tracked);
        });
      this.pendingJobs.add(tracked);
    }
    return ok;
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

  async updateSettings(s: { consolidationModel: AppConfig['consolidationModel'] }): Promise<void> {
    if (s.consolidationModel !== null && this.findProvider(s.consolidationModel.providerId) === undefined) {
      throw new KernelError('invalid', '后台整理供应商不存在');
    }
    this.config.consolidationModel = s.consolidationModel;
    await saveConfig(this.paths, this.config);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.abortAll();
    await Promise.allSettled([...this.pendingJobs]);
    this.consolidator.stop();
    this.db.close();
  }
}
