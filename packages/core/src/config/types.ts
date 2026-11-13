export type ApiFormat = 'chat_completions' | 'responses' | 'anthropic_messages';

export const THINKING_LEVELS = [
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface Provider {
  id: string;
  name: string;
  format: ApiFormat;
  baseUrl: string;
  apiKeyEnv?: string;
  presetId?: string;
  models?: CustomModel[];
}

/** 用户在服务下自己维护的模型；与预设里同名的模型相比优先 */
export interface CustomModel {
  id: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** 是否支持图像识别 */
  vision: boolean;
  /** 支持的推理档位；空数组表示不支持推理档位 */
  thinkingLevels: ThinkingLevel[];
}

export interface AppConfig {
  schemaVersion: 1;
  providers: Provider[];
  mainBotId: string | null;
  consolidationModel: { providerId: string; model: string } | null;
  /** 诊断上传的同意状态与本机标识；旧配置加载时补上，saved 后保持稳定 */
  diagnostics?: AppConfigDiagnostics;
  /** 扩展启用列表的一次性迁移标记；写过一次后不再改动各 bot 的联网开关 */
  extensionsMigrated?: true;
}

/** 每个 bot 已启用的扩展：联网、插件、单独的 MCP server、单独的 skill */
export interface BotExtensions {
  web: boolean;
  plugins: string[];
  mcpServers: string[];
  skills: string[];
}

/** unset：只入本地队列不上传；off：不入队并清空队列；反馈不受此开关限制 */
export type DiagnosticConsent = 'unset' | 'on' | 'off';

export interface AppConfigDiagnostics {
  consent: DiagnosticConsent;
  installId: string;
}

export interface Bot {
  schemaVersion: 1;
  id: string;
  name: string;
  persona: string;
  providerId: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  workspace: string | null;
  approvalMode: ApprovalMode;
  thinkingLevel: ThinkingLevel | null;
  /** 审批时勾选“总是允许”记下的命令原文，只收简单命令 */
  allowedCommands: string[];
  /** 该 bot 已启用的扩展 */
  extensions: BotExtensions;
  /** 审批时勾选“总是允许联网”后为 true，外部联网工具不再询问 */
  allowWeb: boolean;
  /** 审批时勾选“总是允许这个工具”记下的 MCP 工具，条目格式 <serverId>/<原始工具名> */
  allowedMcpTools: string[];
  /** 关闭后不注入记忆主题、不做后台整理 */
  memoryEnabled: boolean;
}

/** ask：读工作区外与所有写入、命令都问；edits：工作区内的写入自动放行，命令仍问；auto：除敏感路径外全放行 */
export type ApprovalMode = 'ask' | 'edits' | 'auto';
export const APPROVAL_MODES: readonly ApprovalMode[] = ['ask', 'edits', 'auto'];

export interface Preset {
  id: string;
  name: string;
  format: ApiFormat;
  baseUrl: string;
  note: string;
  contextWindow: number;
  modelSet?: string;
  thinkingLevels: ThinkingLevel[];
}

export interface KnownModel {
  id: string;
  contextWindow: number;
  thinkingLevels?: ThinkingLevel[];
}
