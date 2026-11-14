import { Kernel, KernelError } from '../kernel.ts';
import type { AddProviderInput, ImageInput, OnboardingInput } from '../kernel.ts';
import { knownModels } from '../config/presets.ts';
import type { RemoteService } from '../remote/service.ts';

export const MAX_BODY_BYTES = 1024 * 1024;
/** 发消息接口可能带最多 4 张 5MB 的图片（base64 后约 6.7MB 每张） */
export const MAX_MESSAGE_BODY_BYTES = 32 * 1024 * 1024;

export class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiRequest {
  method: string;
  url: URL;
  readBody(maxBytes: number): Promise<unknown>;
}

export type ApiResponse =
  | { status: number; json: unknown }
  | { status: number; bytes: Buffer; contentType: string; headers?: Record<string, string> };

/** 远程来源请求了白名单之外的接口 */
export const REMOTE_FORBIDDEN: ApiResponse = {
  status: 403,
  json: { error: { code: 'remote_forbidden', message: '手机端不能使用此功能' } },
};

function json(status: number, data: unknown): ApiResponse {
  return { status, json: data };
}

function errorStatus(code: KernelError['code']): number {
  if (code === 'not_found') return 404;
  if (code === 'conflict' || code === 'provider_in_use') return 409;
  if (code === 'invalid' || code === 'key_not_persistable') return 400;
  if (code === 'rate_limited') return 429;
  if (code === 'network') return 502;
  if (code === 'unavailable') return 503;
  return 500;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KernelError('invalid', '请求体必须是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw new KernelError('invalid', `${key} 必须是字符串`);
  return value;
}

/** 路径段解码：畸形的 % 编码按 400 处理，不要冒成 500 */
function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new KernelError('invalid', '路径参数编码无效');
  }
}

function optionalNumber(raw: string | null): number | undefined {
  if (raw === null || raw.length === 0) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new KernelError('invalid', '数字参数无效');
  return value;
}

export interface DispatchContext {
  /** 本机管理路由（/api/remote）只在本机 HTTP 入口传入；远程网关不传 */
  remote?: RemoteService;
}

export async function dispatchApi(kernel: Kernel, req: ApiRequest, ctx: DispatchContext = {}): Promise<ApiResponse> {
  try {
    return await route(kernel, req, ctx);
  } catch (err) {
    if (err instanceof HttpError) {
      return json(err.status, { error: { code: err.code, message: err.message } });
    }
    if (err instanceof KernelError) {
      return json(errorStatus(err.code), { error: { code: err.code, message: err.message } });
    }
    return json(500, { error: { code: 'internal', message: '服务器内部错误' } });
  }
}

async function route(kernel: Kernel, req: ApiRequest, ctx: DispatchContext): Promise<ApiResponse> {
  const method = req.method;
  const url = req.url;
  const pathname = url.pathname;

  if (pathname === '/api/remote' || pathname.startsWith('/api/remote/')) {
    return await remoteRoute(ctx.remote, req);
  }

  if (method === 'GET' && pathname === '/api/state') {
    return json(200, await kernel.state());
  }
  if (method === 'GET' && pathname === '/api/presets') {
    return json(200, kernel.presets().map((preset) => ({ ...preset, models: knownModels(preset.id) })));
  }
  if (method === 'GET' && pathname === '/api/running') {
    return json(200, kernel.runningThreads());
  }
  if (method === 'GET' && pathname === '/api/approvals') {
    return json(200, kernel.pendingApprovals());
  }
  if (method === 'GET' && pathname === '/api/approvals/log') {
    const botId = url.searchParams.get('botId');
    const before = optionalNumber(url.searchParams.get('before'));
    const limit = optionalNumber(url.searchParams.get('limit'));
    return json(200, kernel.approvalLog({
        ...(botId !== null ? { botId } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }));
  }
  if (method === 'GET' && pathname === '/api/search') {
    const q = url.searchParams.get('q') ?? '';
    const botId = url.searchParams.get('botId');
    const limit = optionalNumber(url.searchParams.get('limit'));
    return json(200, kernel.search(q, {
        ...(botId !== null ? { botId } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }));
  }
  if (method === 'GET' && pathname === '/api/settings') {
    return json(200, kernel.settings());
  }
  if (method === 'GET' && pathname === '/api/extensions/web') {
    return json(200, await kernel.webSettings());
  }
  if (method === 'PUT' && pathname === '/api/extensions/web') {
    const body = objectBody(await req.readBody(MAX_BODY_BYTES));
    if ('fetchEnabled' in body && typeof body['fetchEnabled'] !== 'boolean') {
      throw new KernelError('invalid', 'fetchEnabled 必须是布尔值');
    }
    if ('searchEngine' in body && typeof body['searchEngine'] !== 'string') {
      throw new KernelError('invalid', 'searchEngine 必须是字符串');
    }
    return json(200, await kernel.updateWebSettings(body as Parameters<Kernel['updateWebSettings']>[0]));
  }
  if (method === 'GET' && pathname === '/api/mcp/servers') {
    return json(200, { servers: await kernel.mcpServerList() });
  }
  if (method === 'POST' && pathname === '/api/mcp/servers') {
    const body = objectBody(await req.readBody(MAX_BODY_BYTES));
    return json(200, await kernel.addMcpServer(body as unknown as Parameters<Kernel['addMcpServer']>[0]));
  }
  if (method === 'POST' && pathname === '/api/mcp/parse') {
    const body = objectBody(await req.readBody(MAX_BODY_BYTES));
    return json(200, kernel.parseMcp(stringField(body, 'text')));
  }
  const mcpOne = /^\/api\/mcp\/servers\/([^/]+)$/.exec(pathname);
  if (mcpOne !== null) {
    const id = decodeSegment(mcpOne[1]!);
    if (method === 'PATCH') {
      const body = objectBody(await req.readBody(MAX_BODY_BYTES));
      return json(200, await kernel.updateMcpServer(id, body as unknown as Parameters<Kernel['updateMcpServer']>[1]));
    }
    if (method === 'DELETE') {
      await kernel.deleteMcpServer(id);
      return json(200, { ok: true });
    }
  }
  const mcpAction = /^\/api\/mcp\/servers\/([^/]+)\/(connect|refresh|login|logout)$/.exec(pathname);
  if (mcpAction !== null && method === 'POST') {
    const id = decodeSegment(mcpAction[1]!);
    const action = mcpAction[2]!;
    if (action === 'connect') await kernel.connectMcpServer(id);
    else if (action === 'refresh') await kernel.refreshMcpServer(id);
    else if (action === 'login') await kernel.loginMcpServer(id);
    else await kernel.logoutMcpServer(id);
    return json(200, { ok: true });
  }
  if (method === 'PUT' && pathname === '/api/settings') {
    const body = objectBody(await req.readBody(MAX_BODY_BYTES));
    const value = body['consolidationModel'];
    if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
      throw new KernelError('invalid', 'consolidationModel 无效');
    }
    await kernel.updateSettings({
      consolidationModel: value as { providerId: string; model: string } | null,
    });
    return json(200, { ok: true });
  }
  if (method === 'GET' && pathname === '/api/diagnostics') {
    return json(200, kernel.diagnostics());
  }
  if (method === 'PUT' && pathname === '/api/diagnostics') {
    const body = objectBody(await req.readBody(MAX_BODY_BYTES));
    const consent = body['consent'];
    if (consent !== 'on' && consent !== 'off') throw new KernelError('invalid', 'consent 必须是 on 或 off');
    await kernel.setDiagnostics(consent);
    return json(200, { ok: true });
  }
  if (method === 'GET' && pathname === '/api/diagnostics/logs-preview') {
    return json(200, await kernel.logsPreview());
  }
  if (method === 'POST' && pathname === '/api/diagnostics/client-error') {
    const body = objectBody(await req.readBody(MAX_BODY_BYTES));
    const message = stringField(body, 'message');
    const stack = body['stack'];
    if (stack !== undefined && typeof stack !== 'string') throw new KernelError('invalid', 'stack 必须是字符串');
    return json(200, kernel.reportClientError({ message, ...(stack !== undefined ? { stack } : {}) }));
  }
  if (method === 'POST' && pathname === '/api/feedback') {
    const body = objectBody(await req.readBody(MAX_BODY_BYTES));
    const description = stringField(body, 'description');
    const contact = body['contact'];
    if (contact !== undefined && typeof contact !== 'string') {
      throw new KernelError('invalid', 'contact 必须是字符串');
    }
    const attachLogs = body['attachLogs'] === true;
    return json(
      200,
      await kernel.sendFeedback({ description, ...(contact !== undefined ? { contact } : {}), attachLogs }),
    );
  }
  if (method === 'POST' && pathname === '/api/providers') {
    const body = objectBody(await req.readBody(MAX_BODY_BYTES));
    const provider = await kernel.addProvider(body as unknown as AddProviderInput);
    return json(200, provider);
  }
  if (method === 'POST' && pathname === '/api/onboarding') {
    const body = objectBody(await req.readBody(MAX_BODY_BYTES));
    const bot = await kernel.completeOnboarding(body as unknown as OnboardingInput);
    return json(200, bot);
  }
  if (method === 'PUT' && pathname === '/api/memory/file') {
    const body = objectBody(await req.readBody(MAX_BODY_BYTES));
    const filePath = stringField(body, 'path');
    const content = stringField(body, 'content');
    const baseHash = stringField(body, 'baseHash');
    return json(200, await kernel.writeMemoryFile(filePath, content, baseHash));
  }

  // —— 插件与市场 ——
  if (method === 'GET' && pathname === '/api/plugins') {
    return json(200, { plugins: await kernel.pluginList() });
  }
  if (method === 'POST' && pathname === '/api/plugins/prepare') {
    const body = objectBody(await req.readBody(MAX_BODY_BYTES));
    return json(200, await kernel.pluginPrepare(body as Parameters<Kernel['pluginPrepare']>[0]));
  }
  if (method === 'POST' && pathname === '/api/plugins/confirm') {
    const body = objectBody(await req.readBody(MAX_BODY_BYTES));
    await kernel.pluginConfirm(stringField(body, 'token'));
    return json(200, { ok: true });
  }
  if (method === 'POST' && pathname === '/api/plugins/cancel') {
    const body = objectBody(await req.readBody(MAX_BODY_BYTES));
    await kernel.pluginCancel(stringField(body, 'token'));
    return json(200, { ok: true });
  }
  if (method === 'GET' && pathname === '/api/plugins/updates') {
    return json(200, { updates: await kernel.pluginCheckUpdates() });
  }
  if (method === 'POST' && pathname === '/api/plugins/confirm-update') {
    const body = objectBody(await req.readBody(MAX_BODY_BYTES));
    await kernel.pluginConfirmUpdate(stringField(body, 'token'));
    return json(200, { ok: true });
  }
  if (method === 'GET' && pathname === '/api/markets') {
    return json(200, { markets: await kernel.markets() });
  }
  if (method === 'POST' && pathname === '/api/markets') {
    const body = objectBody(await req.readBody(MAX_BODY_BYTES));
    await kernel.addMarket(stringField(body, 'url'));
    return json(200, { ok: true });
  }
  if (method === 'DELETE' && pathname === '/api/markets') {
    const fromQuery = url.searchParams.get('url');
    if (fromQuery !== null) {
      await kernel.removeMarket(fromQuery);
    } else {
      const body = objectBody(await req.readBody(MAX_BODY_BYTES));
      await kernel.removeMarket(stringField(body, 'url'));
    }
    return json(200, { ok: true });
  }
  if (method === 'GET' && pathname === '/api/markets/plugins') {
    const marketUrl = url.searchParams.get('url');
    if (marketUrl === null) throw new KernelError('invalid', '缺少 url 参数');
    return json(200, { plugins: await kernel.marketPlugins(marketUrl) });
  }
  {
    const pluginAction = /^\/api\/plugins\/([^/]+)\/(connect|prepare-update)$/.exec(pathname);
    if (pluginAction !== null && method === 'POST') {
      const name = decodeSegment(pluginAction[1]!);
      const body = objectBody(await req.readBody(MAX_BODY_BYTES));
      if (pluginAction[2] === 'connect') {
        const values = body['values'];
        if (typeof values !== 'object' || values === null || Array.isArray(values)) {
          throw new KernelError('invalid', 'values 必须是对象');
        }
        await kernel.pluginConnect(name, values as Record<string, string>);
        return json(200, { ok: true });
      }
      return json(200, await kernel.pluginPrepareUpdate(name));
    }
    const pluginOne = /^\/api\/plugins\/([^/]+)$/.exec(pathname);
    if (pluginOne !== null) {
      const name = decodeSegment(pluginOne[1]!);
      if (method === 'PATCH') {
        const body = objectBody(await req.readBody(MAX_BODY_BYTES));
        if (typeof body['enabled'] !== 'boolean') throw new KernelError('invalid', 'enabled 必须是布尔值');
        await kernel.pluginSetEnabled(name, body['enabled']);
        return json(200, { ok: true });
      }
      if (method === 'DELETE') {
        await kernel.pluginDelete(name);
        return json(200, { ok: true });
      }
    }
  }

  // —— Skill ——
  if (method === 'GET' && pathname === '/api/skills') {
    return json(200, await kernel.skillList());
  }
  if (method === 'POST' && pathname === '/api/skills') {
    const body = objectBody(await req.readBody(MAX_BODY_BYTES));
    return json(201, await kernel.addSkill(stringField(body, 'dir')));
  }
  {
    const skillOne = /^\/api\/skills\/(.+)$/.exec(pathname);
    if (skillOne !== null && method === 'DELETE') {
      await kernel.removeSkill(decodeSegment(skillOne[1]!));
      return json(200, { ok: true });
    }
  }
  {
    const botSkills = /^\/api\/bots\/([^/]+)\/skills$/.exec(pathname);
    if (botSkills !== null && method === 'GET') {
      return json(200, { skills: await kernel.botSkills(decodeSegment(botSkills[1]!)) });
    }
  }

  let match = /^\/api\/providers\/([^/]+)$/.exec(pathname);
  if (match !== null) {
    const id = decodeSegment(match[1]!);
    if (method === 'PATCH') {
      const body = objectBody(await req.readBody(MAX_BODY_BYTES));
      return json(200, await kernel.updateProvider(id, body));
    }
    if (method === 'DELETE') {
      await kernel.deleteProvider(id);
      return json(200, { ok: true });
    }
  }

  match = /^\/api\/providers\/([^/]+)\/test$/.exec(pathname);
  if (match !== null && method === 'POST') {
    const id = decodeSegment(match[1]!);
    const body = objectBody(await req.readBody(MAX_BODY_BYTES));
    const model = stringField(body, 'model');
    return json(200, await kernel.testProvider(id, model));
  }

  match = /^\/api\/bots\/([^/]+)$/.exec(pathname);
  if (match !== null && method === 'PATCH') {
    const id = decodeSegment(match[1]!);
    const body = objectBody(await req.readBody(MAX_BODY_BYTES));
    return json(200, await kernel.updateBot(id, body));
  }

  match = /^\/api\/bots\/([^/]+)\/threads$/.exec(pathname);
  if (match !== null) {
    const id = decodeSegment(match[1]!);
    if (method === 'GET') {
      return json(200, kernel.listThreads(id));
    }
    if (method === 'POST') {
      return json(200, kernel.createThread(id));
    }
  }

  match = /^\/api\/bots\/([^/]+)\/memory$/.exec(pathname);
  if (match !== null && method === 'GET') {
    const id = decodeSegment(match[1]!);
    return json(200, await kernel.listMemory(id));
  }

  match = /^\/api\/threads\/([^/]+)\/messages$/.exec(pathname);
  if (match !== null) {
    const id = decodeSegment(match[1]!);
    if (method === 'GET') {
      const before = optionalNumber(url.searchParams.get('before'));
      const limit = optionalNumber(url.searchParams.get('limit'));
      return json(200, kernel.listMessages(id, before, limit));
    }
    if (method === 'POST') {
      const body = objectBody(await req.readBody(MAX_MESSAGE_BODY_BYTES));
      const text = stringField(body, 'text');
      const images = body['images'] ?? [];
      if (!Array.isArray(images)) throw new KernelError('invalid', 'images 必须是数组');
      const skills = body['skills'] ?? [];
      if (!Array.isArray(skills) || !skills.every((s) => typeof s === 'string')) {
        throw new KernelError('invalid', 'skills 必须是字符串数组');
      }
      const mode =
        skills.length > 0
          ? await kernel.sendMessageWithSkills(id, text, images as ImageInput[], skills as string[])
          : kernel.sendMessage(id, text, images as ImageInput[]);
      return json(200, { ok: true, mode });
    }
  }

  match = /^\/api\/threads\/([^/]+)$/.exec(pathname);
  if (match !== null) {
    const id = decodeSegment(match[1]!);
    if (method === 'GET') {
      return json(200, kernel.thread(id));
    }
    if (method === 'PATCH') {
      const body = objectBody(await req.readBody(MAX_BODY_BYTES));
      return json(200, kernel.renameThread(id, stringField(body, 'title')));
    }
    if (method === 'DELETE') {
      await kernel.deleteThread(id);
      return json(200, { ok: true });
    }
  }

  match = /^\/api\/threads\/([^/]+)\/retry$/.exec(pathname);
  if (match !== null && method === 'POST') {
    kernel.retry(decodeSegment(match[1]!));
    return json(200, { ok: true });
  }

  match = /^\/api\/threads\/([^/]+)\/usage$/.exec(pathname);
  if (match !== null && method === 'GET') {
    return json(200, kernel.threadUsage(decodeSegment(match[1]!)));
  }

  match = /^\/api\/attachments\/([^/]+)$/.exec(pathname);
  if (match !== null && method === 'GET') {
    const file = await kernel.readAttachment(decodeSegment(match[1]!));
    return {
      status: 200,
      bytes: file.data,
      contentType: file.mediaType,
      headers: { 'cache-control': 'private, max-age=31536000, immutable' },
    };
  }

  match = /^\/api\/threads\/([^/]+)\/context$/.exec(pathname);
  if (match !== null && method === 'GET') {
    const id = decodeSegment(match[1]!);
    return json(200, await kernel.contextUsage(id));
  }

  match = /^\/api\/threads\/([^/]+)\/compact$/.exec(pathname);
  if (match !== null && method === 'POST') {
    const id = decodeSegment(match[1]!);
    kernel.compact(id);
    return json(200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/memory/file') {
    const filePath = url.searchParams.get('path');
    if (filePath === null) throw new KernelError('invalid', '缺少 path 参数');
    return json(200, await kernel.readMemoryFile(filePath));
  }
  if (method === 'GET' && pathname === '/api/memory/revisions') {
    const filePath = url.searchParams.get('path');
    if (filePath === null) throw new KernelError('invalid', '缺少 path 参数');
    return json(200, kernel.listRevisions(filePath));
  }

  match = /^\/api\/memory\/revisions\/([^/]+)\/revert$/.exec(pathname);
  if (match !== null && method === 'POST') {
    const revisionId = Number(decodeSegment(match[1]!));
    if (!Number.isInteger(revisionId)) throw new KernelError('invalid', '修订 id 无效');
    await kernel.revert(revisionId);
    return json(200, { ok: true });
  }

  return json(404, { error: { code: 'not_found', message: '接口不存在' } });
}

const notFound = (): ApiResponse => json(404, { error: { code: 'not_found', message: '接口不存在' } });

async function remoteRoute(remote: RemoteService | undefined, req: ApiRequest): Promise<ApiResponse> {
  if (remote === undefined) return notFound();
  const { method } = req;
  const pathname = req.url.pathname;
  if (pathname === '/api/remote') {
    if (method === 'GET') return json(200, remote.status());
    if (method === 'PUT') {
      const body = objectBody(await req.readBody(MAX_BODY_BYTES));
      return json(200, await remote.updateConfig(remotePatch(body)));
    }
    return notFound();
  }
  if (pathname === '/api/remote/pairing') {
    if (method === 'POST') return json(200, remote.startPairing());
    if (method === 'DELETE') return json(200, remote.cancelPairing());
    return notFound();
  }
  const match = /^\/api\/remote\/devices\/([^/]+)$/.exec(pathname);
  if (match !== null && method === 'DELETE') {
    return json(200, await remote.revoke(decodeSegment(match[1]!)));
  }
  return notFound();
}

function remotePatch(body: Record<string, unknown>): Parameters<RemoteService['updateConfig']>[0] {
  const patch: Parameters<RemoteService['updateConfig']>[0] = {};
  const take = <T>(key: string, check: (v: unknown) => v is T, label: string): T | undefined => {
    if (!(key in body)) return undefined;
    const value = body[key];
    if (!check(value)) throw new KernelError('invalid', `${key} 必须是${label}`);
    return value;
  };
  const isString = (v: unknown): v is string => typeof v === 'string';
  const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
  const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
  const isNumber = (v: unknown): v is number => typeof v === 'number';
  const relayUrl = take('relayUrl', isStringOrNull, '字符串或 null');
  if (relayUrl !== undefined) patch.relayUrl = relayUrl;
  const lanEnabled = take('lanEnabled', isBool, '布尔值');
  if (lanEnabled !== undefined) patch.lanEnabled = lanEnabled;
  const lanPort = take('lanPort', isNumber, '数字');
  if (lanPort !== undefined) patch.lanPort = lanPort;
  const pcName = take('pcName', isString, '字符串');
  if (pcName !== undefined) patch.pcName = pcName;
  const relayToken = take('relayToken', isStringOrNull, '字符串或 null');
  if (relayToken !== undefined) patch.relayToken = relayToken;
  return patch;
}
