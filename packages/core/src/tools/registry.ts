import { promises as fs } from 'node:fs';
import type { Bot } from '../config/types.ts';
import type { DataPaths } from '../paths.ts';
import type { ApprovalBroker, ApprovalRequestInput } from '../approval/broker.ts';
import { decide, decideExternal, isDirectTool, isSimpleCommand, type ToolName } from '../approval/policy.ts';
import { CANCELLED_TEXT } from '../db/messages.ts';
import type { MemoryRevisions } from '../memory/revisions.ts';
import type { SecretSet } from '../secrets/redact.ts';
import type { ToolSpec } from '../model/adapter.ts';
import type { Block } from '../model/types.ts';
import { classifyPath, resolveReal } from './path-guard.ts';
import type { ReadTracker } from './read-tracker.ts';
import { readFile, writeFile, editFile } from './files.ts';
import { globFiles, grepFiles } from './search.ts';
import { runCommand } from './run-command.ts';
import { clipToOutputs } from './output.ts';
import { loadSkill } from '../skills/load-skill.ts';
import type { ExternalTool, TurnToolset } from './catalog.ts';
import type { ToolOutput } from './types.ts';
import type { DiagLog } from '../diag/log.ts';

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'read_file',
    description: '读取工作目录中的文本文件。输出带行号，默认从第 1 行开始、最多 2000 行。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对工作目录或绝对路径' },
        offset: { type: 'number', description: '起始行号（从 1 开始）' },
        limit: { type: 'number', description: '最多读取的行数' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '新建文件或整体覆盖已有文件。覆盖前必须在本线程读取过该文件且未被改动。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '完整的文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: '精确替换文件中的一段文本。旧文本必须唯一匹配，除非设置 replace_all。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        old_string: { type: 'string', description: '要被替换的原文本' },
        new_string: { type: 'string', description: '替换后的文本' },
        replace_all: { type: 'boolean', description: '是否替换所有匹配' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'glob',
    description: '按模式查找文件并返回相对路径。不递归的模式（如 *）用于列目录。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，如 **/*.ts' },
        path: { type: 'string', description: '搜索目录，默认工作目录' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: '用正则搜索文件内容，尊重 .gitignore 并跳过二进制文件。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索目录，默认工作目录' },
        glob: { type: 'string', description: '只搜索匹配该 glob 的文件' },
        ignore_case: { type: 'boolean', description: '是否忽略大小写' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_command',
    description: '在工作目录执行命令。Windows 用 PowerShell，Linux 用 bash。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令原文' },
        timeout_ms: { type: 'number', description: '超时毫秒数，默认 120000，最大 600000' },
      },
      required: ['command'],
    },
  },
];

export interface ToolEnv {
  bot: Bot;
  threadId: string;
  workspace: string;
  paths: DataPaths;
  home: string;
  tracker: ReadTracker;
  secrets: SecretSet;
  revisions: MemoryRevisions;
  broker: ApprovalBroker;
  signal: AbortSignal;
  /** 本轮工具快照；内置工具不需要它，外部工具靠它找实现 */
  toolset?: TurnToolset;
  /** 当前模型是否支持图片，作为 ExternalCallContext.supportsImages */
  supportsImages?: boolean;
  /** run_command 子进程的环境变量；不给则继承内核进程的环境 */
  childEnv?: NodeJS.ProcessEnv;
  /** 命令是否在“总是允许”名单里；内核读最新的 bot 配置，不给时用 bot.allowedCommands */
  isCommandAllowed?: (command: string) => Promise<boolean>;
  /** 外部工具是否已在“总是允许”名单里（联网看 allowWeb，MCP 看 allowedMcpTools） */
  isExternalAllowed?: (tool: ExternalTool) => Promise<boolean>;
  /** 命中“总是允许”名单而跳过审批时调用，用于决策日志 */
  onAllowlisted?: (request: ApprovalRequestInput) => void;
  /** 本地日志与诊断事件；不给则不记录 */
  diag?: DiagLog;
}

async function realOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

type ToolResultBlock = Extract<Block, { type: 'tool_result' }>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateParams(name: string, input: Record<string, unknown>): string | null {
  const requireString = (key: string): string | null =>
    typeof input[key] === 'string' ? null : `参数错误：${key} 必须是字符串。`;
  const optionalNumber = (key: string): string | null =>
    input[key] === undefined || typeof input[key] === 'number'
      ? null
      : `参数错误：${key} 必须是数字。`;
  const optionalString = (key: string): string | null =>
    input[key] === undefined || typeof input[key] === 'string'
      ? null
      : `参数错误：${key} 必须是字符串。`;
  const optionalBoolean = (key: string): string | null =>
    input[key] === undefined || typeof input[key] === 'boolean'
      ? null
      : `参数错误：${key} 必须是布尔值。`;

  if (name === 'read_file') {
    return requireString('path') ?? optionalNumber('offset') ?? optionalNumber('limit');
  }
  if (name === 'write_file') {
    return requireString('path') ?? requireString('content');
  }
  if (name === 'edit_file') {
    return (
      requireString('path') ??
      requireString('old_string') ??
      requireString('new_string') ??
      optionalBoolean('replace_all')
    );
  }
  if (name === 'glob') {
    return requireString('pattern') ?? optionalString('path');
  }
  if (name === 'grep') {
    return (
      requireString('pattern') ??
      optionalString('path') ??
      optionalString('glob') ??
      optionalBoolean('ignore_case')
    );
  }
  if (name === 'run_command') {
    return requireString('command') ?? optionalNumber('timeout_ms');
  }
  return `未知工具：${name}`;
}

function pathOf(name: string, input: Record<string, unknown>): string {
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file') {
    return input['path'] as string;
  }
  return typeof input['path'] === 'string' && input['path'].length > 0 ? input['path'] : '.';
}

function summarize(name: string, input: Record<string, unknown>, real: string): string {
  const target = `${input['path'] as string}（${real}）`;
  if (name === 'read_file') return `读取文件：${target}`;
  if (name === 'write_file') return `写入文件：${target}`;
  if (name === 'edit_file') return `修改文件：${target}`;
  if (name === 'glob') return `查找文件：${String(input['pattern'])}（${real}）`;
  if (name === 'grep') return `搜索内容：${String(input['pattern'])}（${real}）`;
  return `执行命令：${String(input['command'])}`;
}

const PREVIEW_MAX_CHARS = 4000;

function clipPreview(text: string): string {
  return text.length > PREVIEW_MAX_CHARS
    ? `${text.slice(0, PREVIEW_MAX_CHARS)}\n…[已截断，共 ${text.length} 字符]`
    : text;
}

/** 审批卡片上的内容预览：write_file 是要写入的内容，edit_file 是旧文本与新文本 */
function previewOf(name: string, input: Record<string, unknown>, redact: (text: string) => string): string | undefined {
  if (name === 'write_file') return clipPreview(redact(input['content'] as string));
  if (name === 'edit_file') {
    const oldText = clipPreview(redact(input['old_string'] as string));
    const newText = clipPreview(redact(input['new_string'] as string));
    return `旧文本：\n${oldText}\n\n新文本：\n${newText}`;
  }
  return undefined;
}

export async function executeTool(
  call: Extract<Block, { type: 'tool_use' }>,
  env: ToolEnv,
): Promise<ToolResultBlock> {
  const started = Date.now();
  const result = await runTool(call, env);
  if (env.diag !== undefined) reportTool(env.diag, call, env, result, Date.now() - started);
  return result;
}

const KNOWN_TOOLS = new Set(TOOL_SPECS.map((t) => t.name));

/** 完整日志写命令原文与路径；事件只带工具名、类别与退出码，且只在真正出错或超时时发出 */
function reportTool(diag: DiagLog, call: Extract<Block, { type: 'tool_use' }>, env: ToolEnv, result: ToolResultBlock, durationMs: number): void {
  diag.addWorkspace(env.workspace);
  const input = isRecord(call.input) ? call.input : {};
  const builtin = KNOWN_TOOLS.has(call.name) || call.name === 'load_skill';
  const external = builtin ? undefined : env.toolset?.external(call.name);
  const exit = builtin && call.name === 'run_command' ? /^退出码: (-?\d+)/.exec(result.content) : null;
  const exitCode = exit === null ? undefined : Number(exit[1]);
  const timedOut = builtin && call.name === 'run_command' && /^超时: 是/m.test(result.content);
  // 参数错误与未知工具是模型的问题，不算应用故障
  const modelMistake = result.status === 'error' && /^(参数错误|未知工具)/.test(result.content);
  const failed = (result.status === 'error' && !modelMistake) || timedOut;
  // 外部工具只记来源类型（web / mcp），不记 server 名、URL、参数；不认识的外部工具记 unknown
  const name = builtin ? call.name : external === undefined ? 'unknown' : external.source.kind;
  diag.write(
    failed ? 'error' : 'info',
    'tool',
    'tool.call',
    {
      tool: name,
      status: result.status,
      durationMs,
      exitCode,
      timedOut: timedOut || undefined,
      ...(builtin && typeof input['path'] === 'string' ? { path: input['path'] } : {}),
      ...(builtin && typeof input['command'] === 'string' ? { command: input['command'] } : {}),
      // run_command 的内容含命令输出，不进日志；其他工具的错误文案是固定的
      ...(failed && builtin && call.name !== 'run_command' ? { error: result.content.slice(0, 500) } : {}),
    },
    failed
      ? {
          kind: 'error',
          name: `tool.${name}`,
          data: { category: timedOut ? 'timeout' : 'error', ...(exitCode !== undefined ? { exitCode } : {}) },
        }
      : undefined,
  );
}

type FailFn = (content: string, status?: ToolResultBlock['status']) => ToolResultBlock;

/** 外部工具的审批请求：tool 填模型看到的工具名，来源只带类型与 server 名，不含参数 */
function externalRequest(
  tool: ExternalTool,
  input: Record<string, unknown>,
  call: Extract<Block, { type: 'tool_use' }>,
  env: ToolEnv,
): ApprovalRequestInput {
  const previewText = tool.preview?.(input);
  const preview = previewText === undefined ? undefined : clipPreview(env.secrets.redact(previewText));
  const source = tool.source;
  const base: ApprovalRequestInput = {
    botId: env.bot.id,
    threadId: env.threadId,
    tool: call.name,
    summary: env.secrets.redact(tool.summarize(input)),
    canAlwaysAllow: true,
    source: source.kind,
    ...(preview !== undefined ? { preview } : {}),
  };
  if (source.kind === 'mcp') {
    base.serverName = source.serverName;
    base.alwaysKind = 'mcp_tool';
    base.mcpToolKey = `${source.serverId}/${source.toolName}`;
  } else {
    base.alwaysKind = 'web';
  }
  return base;
}

/** 外部工具统一路径：校验 → 审批（含“总是允许”）→ 执行 → 截断 → 脱敏 */
async function runExternalTool(
  call: Extract<Block, { type: 'tool_use' }>,
  input: Record<string, unknown>,
  env: ToolEnv,
  fail: FailFn,
): Promise<ToolResultBlock> {
  const tool = env.toolset?.external(call.name);
  if (tool === undefined) return fail(`未知工具：${call.name}`);
  const validationError = tool.validate?.(input) ?? null;
  if (validationError !== null) return fail(validationError);
  if (env.signal.aborted) return fail(CANCELLED_TEXT, 'cancelled');

  if (decideExternal(env.bot.approvalMode, tool.source.kind) === 'ask') {
    const request = externalRequest(tool, input, call, env);
    // 内核在 bot.json 路径锁里读最新配置：本轮中途刚勾选的“总是允许”也能生效
    const allowlisted = (await env.isExternalAllowed?.(tool)) ?? false;
    if (allowlisted) {
      env.onAllowlisted?.(request);
    } else {
      const approval = await env.broker.request(request, env.signal);
      if (approval === 'denied') return fail('用户拒绝了此操作', 'denied');
      if (approval === 'cancelled') return fail(CANCELLED_TEXT, 'cancelled');
    }
  }

  try {
    const output = await tool.run(input, {
      bot: env.bot,
      threadId: env.threadId,
      signal: env.signal,
      supportsImages: env.supportsImages ?? true,
    });
    if (env.signal.aborted) return fail(CANCELLED_TEXT, 'cancelled');
    // 先脱敏再截断：写入 outputs 的完整文本不含密钥，截断边界也不会切开密钥
    const content = await clipToOutputs(env.secrets.redact(output.content), env.paths.outputs);
    return {
      type: 'tool_result',
      toolUseId: call.id,
      content,
      status: output.isError ? 'error' : 'ok',
    };
  } catch (err) {
    // 中断时工具多半以抛异常结束：按取消处理，不算执行失败
    if (env.signal.aborted) return fail(CANCELLED_TEXT, 'cancelled');
    const message = err instanceof Error ? err.message : String(err);
    return fail(`工具执行失败：${message}`);
  }
}

async function runTool(
  call: Extract<Block, { type: 'tool_use' }>,
  env: ToolEnv,
): Promise<ToolResultBlock> {
  const fail = (content: string, status: ToolResultBlock['status'] = 'error'): ToolResultBlock => ({
    type: 'tool_result',
    toolUseId: call.id,
    content: env.secrets.redact(content),
    status,
  });

  try {
    const input = call.input;
    if (!isRecord(input)) return fail('参数错误：input 必须是对象。');
    if (isDirectTool(call.name)) {
      if (env.signal.aborted) return fail(CANCELLED_TEXT, 'cancelled');
      try {
        const text = await loadSkill(env.toolset?.skills ?? [], input);
        const content = await clipToOutputs(env.secrets.redact(text), env.paths.outputs);
        return { type: 'tool_result', toolUseId: call.id, content, status: 'ok' };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
    if (!KNOWN_TOOLS.has(call.name)) return await runExternalTool(call, input, env, fail);
    const validationError = validateParams(call.name, input);
    if (validationError !== null) return fail(validationError);
    if (env.signal.aborted) return fail(CANCELLED_TEXT, 'cancelled');

    const fileCtx = {
      tracker: env.tracker,
      secrets: env.secrets,
      revisions: env.revisions,
      paths: env.paths,
      actor: env.bot.id,
    };

    const classes: ReturnType<typeof classifyPath>[] = [];
    let real = '';
    if (call.name !== 'run_command') {
      real = await resolveReal(pathOf(call.name, input), env.workspace, env.home);
      classes.push(
        classifyPath(real, {
          paths: env.paths,
          botId: env.bot.id,
          workspace: await realOrSelf(env.workspace),
          home: await realOrSelf(env.home),
        }),
      );
    }

    const toolName = call.name as ToolName;
    if (decide(env.bot.approvalMode, toolName, classes) === 'ask') {
      const command = call.name === 'run_command' ? (input['command'] as string) : undefined;
      const simple = command !== undefined && isSimpleCommand(command);
      const preview = previewOf(call.name, input, (text) => env.secrets.redact(text));
      const request = {
        botId: env.bot.id,
        threadId: env.threadId,
        tool: toolName,
        summary: summarize(call.name, input, real),
        ...(command !== undefined ? { command } : {}),
        ...(preview !== undefined ? { preview } : {}),
      };
      const allowlisted =
        simple &&
        command !== undefined &&
        (await (env.isCommandAllowed?.(command) ?? env.bot.allowedCommands.includes(command)));
      if (allowlisted) {
        env.onAllowlisted?.(request);
      } else {
        const approval = await env.broker.request({ ...request, canAlwaysAllow: simple }, env.signal);
        if (approval === 'denied') return fail('用户拒绝了此操作', 'denied');
        if (approval === 'cancelled') return fail(CANCELLED_TEXT, 'cancelled');
      }
    }

    let output: ToolOutput;
    if (call.name === 'read_file') {
      output = await readFile(fileCtx, real, {
        offset: input['offset'] as number | undefined,
        limit: input['limit'] as number | undefined,
      });
    } else if (call.name === 'write_file') {
      output = await writeFile(fileCtx, real, { content: input['content'] as string });
    } else if (call.name === 'edit_file') {
      output = await editFile(fileCtx, real, {
        old_string: input['old_string'] as string,
        new_string: input['new_string'] as string,
        replace_all: input['replace_all'] as boolean | undefined,
      });
    } else if (call.name === 'glob') {
      output = await globFiles(real, { pattern: input['pattern'] as string }, env.signal);
    } else if (call.name === 'grep') {
      output = await grepFiles(
        real,
        {
          pattern: input['pattern'] as string,
          glob: input['glob'] as string | undefined,
          ignore_case: input['ignore_case'] as boolean | undefined,
        },
        env.signal,
      );
    } else {
      output = await runCommand(
        {
          cwd: env.workspace,
          outputsDir: env.paths.outputs,
          signal: env.signal,
          redact: (text) => env.secrets.redact(text),
          ...(env.childEnv !== undefined ? { env: env.childEnv } : {}),
        },
        { command: input['command'] as string, timeout_ms: input['timeout_ms'] as number | undefined },
      );
    }

    if (env.signal.aborted) {
      return fail(CANCELLED_TEXT, 'cancelled');
    }
    return {
      type: 'tool_result',
      toolUseId: call.id,
      content: env.secrets.redact(output.content),
      status: output.isError ? 'error' : 'ok',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`工具执行失败：${message}`);
  }
}
