import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { dataPaths, type DataPaths } from './paths.ts';
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
import { createThread, getThread, listThreads, type Thread } from './db/threads.ts';
import {
  appendMessage,
  listMessages,
  repairDanglingToolUses,
  type ListMessagesOptions,
} from './db/messages.ts';
import type { KernelEvent } from './events.ts';
import { ThreadQueue } from './agent/queue.ts';
import { ApprovalBroker, type ApprovalRequest } from './approval/broker.ts';
import { runTurn, type TurnDeps } from './agent/loop.ts';
import { compactThread, makePrepareContext } from './agent/compaction.ts';
import { buildTopicIndex } from './memory/topics.ts';
import { MemoryRevisions, type Revision } from './memory/revisions.ts';
import { Consolidator } from './memory/consolidate.ts';
import { SecretSet } from './secrets/redact.ts';
import { SecretStore, type KeyCrypto } from './secrets/store.ts';
import { ReadTracker } from './tools/read-tracker.ts';
import type { ToolEnv } from './tools/registry.ts';
import { callModel as defaultCallModel, testConnection, type CallModel } from './model/client.ts';
import type { StoredMessage } from './model/types.ts';

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
    this.revisions = new MemoryRevisions(this.db, this.paths);
    this.broker = new ApprovalBroker((e) => this.emit(e));
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
      >
    >,
  ): Promise<Bot> {
    const bot = await this.loadBotOrThrow(id);
    if (patch.name !== undefined) bot.name = patch.name;
    if (patch.persona !== undefined) bot.persona = patch.persona;
    if (patch.providerId !== undefined) bot.providerId = patch.providerId;
    if (patch.model !== undefined) bot.model = patch.model;
    if (patch.workspace !== undefined) bot.workspace = patch.workspace;
    if (patch.approvalMode !== undefined) {
      if (patch.approvalMode !== 'ask' && patch.approvalMode !== 'auto') {
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

  listMessages(threadId: string, before?: number, limit?: number): StoredMessage[] {
    const options: ListMessagesOptions = { limit: limit ?? 50 };
    if (before !== undefined) options.before = before;
    return listMessages(this.db, threadId, options);
  }

  sendMessage(threadId: string, text: string): void {
    const thread = getThread(this.db, threadId);
    if (thread === null) throw new KernelError('not_found', '线程不存在');
    const job = this.queue.enqueue(threadId, async (signal) => {
      const bot = await this.loadBotOrThrow(thread.botId);
      await runTurn(
        {
          db: this.db,
          callModel: this.callModel,
          emit: (e) => this.emit(e),
          resolveModel: (b) => this.resolveModel(b),
          makeToolEnv: (b, id, s) => this.makeToolEnv(b, id, s),
          prepareContext: this.prepareContext,
        },
        bot,
        threadId,
        text,
        signal,
      );
    });
    const tracked = job
      .catch(() => {})
      .finally(() => {
        this.pendingJobs.delete(tracked);
      });
    this.pendingJobs.add(tracked);
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

  respondApproval(id: string, approve: boolean): boolean {
    return this.broker.respond(id, approve);
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
