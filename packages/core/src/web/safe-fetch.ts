import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { isBlockedAddress } from './ip-guard.ts';

export type FetchErrorCode =
  | 'invalid_url'
  | 'blocked'
  | 'timeout'
  | 'too_large'
  | 'too_many_redirects'
  | 'network'
  | 'http_status'
  | 'unsupported_type'
  | 'aborted';

const DEFAULT_MESSAGES: Record<FetchErrorCode, string> = {
  invalid_url: '网址无效：只支持 http/https，且不能包含用户名或密码',
  blocked: '拒绝访问本机或内网地址',
  timeout: '抓取超时（20 秒）',
  too_large: '网页超过 5 MB 上限',
  too_many_redirects: '跳转次数超过 5 次',
  network: '网络错误',
  http_status: '网页返回 HTTP 错误',
  unsupported_type: '不支持的内容类型',
  aborted: '已取消',
};

export class FetchError extends Error {
  readonly code: FetchErrorCode;

  constructor(code: FetchErrorCode, message?: string) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'FetchError';
    this.code = code;
  }
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  charset: string | null;
  body: Buffer;
}

export interface SafeFetchDeps {
  lookup?: (host: string) => Promise<string[]>;
  isBlocked?: (ip: string) => boolean;
  now?: () => number;
  /** 仅测试用：覆盖 20 秒总超时 */
  timeoutMs?: number;
}

export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const DEFAULT_TIMEOUT_MS = 20_000;

const ALLOWED_TYPES = new Set(['text/html', 'text/plain', 'application/json', 'text/markdown']);
const REQUEST_HEADERS = {
  'User-Agent': 'minibot',
  Accept: 'text/html,text/plain,application/json,text/markdown;q=0.9,*/*;q=0.1',
  'Accept-Encoding': 'gzip, deflate, br',
};

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function validateUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('invalid_url');
  if (url.username !== '' || url.password !== '') throw new FetchError('invalid_url');
  if (url.hostname === '') throw new FetchError('invalid_url');
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/** 把连接固定到已检查过的地址；Host 头与 TLS SNI 仍用原主机名 */
function fixedLookup(address: string, family: number): http.RequestOptions['lookup'] {
  const fn = (_hostname: string, opts: dns.LookupOptions, callback: LookupCallback): void => {
    if ((opts as { all?: boolean }).all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
  return fn as unknown as http.RequestOptions['lookup'];
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  res: http.IncomingMessage;
}

function requestOnce(url: URL, address: string, family: number, signal: AbortSignal): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const host = stripBrackets(url.hostname);
    const options: https.RequestOptions = {
      protocol: url.protocol,
      hostname: host,
      port: url.port === '' ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: REQUEST_HEADERS,
      lookup: fixedLookup(address, family),
      signal,
    };
    if (url.protocol === 'https:' && net.isIP(host) === 0) options.servername = host;
    const req = client.request(options, (res) => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers, res });
    });
    req.on('error', reject);
    req.end();
  });
}

async function readBody(res: http.IncomingMessage, encoding: string | undefined, signal: AbortSignal): Promise<Buffer> {
  const enc = (encoding ?? '').toLowerCase();
  const decoder = enc.includes('gzip')
    ? createGunzip()
    : enc.includes('deflate')
      ? createInflate()
      : enc.includes('br')
        ? createBrotliDecompress()
        : null;
  // 用 pipeline 而不是 pipe：连接被断开时错误会传给解压流，读取循环随之结束，不会挂住
  const stream: NodeJS.ReadableStream & { destroy(err?: Error): void } =
    decoder === null ? res : pipeline(res, decoder, () => {});
  // 超时或外部中止时直接销毁读取端，数据停住时也能立即结束
  const onAbort = (): void => {
    res.destroy();
    stream.destroy(new Error('aborted'));
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array);
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        res.destroy();
        stream.destroy();
        throw new FetchError('too_large');
      }
      chunks.push(buf);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (signal.aborted) throw new Error('aborted');
  return Buffer.concat(chunks);
}

/** DNS 解析本身不能取消：与中止信号赛跑，超时或停止时立即结束 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 安全抓取：解析 DNS 后检查全部地址、把连接固定到检查过的 IP、手动处理跳转并每跳重新检查，
 * 总超时 20 秒、响应体 5 MB 上限、只接受四种内容类型。
 */
export async function safeFetch(input: string, signal: AbortSignal, deps: SafeFetchDeps = {}): Promise<SafeFetchResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const isBlocked = deps.isBlocked ?? isBlockedAddress;
  const controller = new AbortController();
  let timedOut = false;
  let externalAborted = signal.aborted;
  const onAbort = (): void => {
    externalAborted = true;
    controller.abort();
  };
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();

  try {
    let current: URL;
    try {
      current = new URL(input);
    } catch {
      throw new FetchError('invalid_url');
    }
    let redirects = 0;
    for (;;) {
      validateUrl(current);
      const host = stripBrackets(current.hostname);
      let addresses: string[];
      if (net.isIP(host) !== 0) {
        addresses = [host];
      } else {
        try {
          addresses = await raceAbort(
            deps.lookup !== undefined
              ? deps.lookup(host)
              : dns.promises.lookup(host, { all: true }).then((list) => list.map((entry) => entry.address)),
            controller.signal,
          );
        } catch (err) {
          if (controller.signal.aborted) throw err;
          throw new FetchError('network', `网络错误：${errorMessage(err)}`);
        }
        if (addresses.length === 0) throw new FetchError('network', '网络错误：没有可用的地址');
      }
      // 只要有一个地址被拒就整体拒绝，不挑公网那个连
      if (addresses.some((address) => isBlocked(address))) throw new FetchError('blocked');

      const family = net.isIP(addresses[0]!);
      const response = await requestOnce(current, addresses[0]!, family === 0 ? 4 : family, controller.signal);
      const location = response.headers.location;

      if (response.status >= 300 && response.status < 400 && typeof location === 'string') {
        // 不读的响应体直接断开，免得连接在返回后还挂着
        response.res.destroy();
        if (redirects >= MAX_REDIRECTS) throw new FetchError('too_many_redirects');
        redirects += 1;
        try {
          current = new URL(location, current);
        } catch {
          throw new FetchError('invalid_url');
        }
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        response.res.destroy();
        throw new FetchError('http_status', `网页返回 HTTP ${response.status}`);
      }

      const contentType = String(response.headers['content-type'] ?? '');
      const [mediaTypeRaw, ...params] = contentType.split(';');
      const mediaType = (mediaTypeRaw ?? '').trim().toLowerCase();
      if (!ALLOWED_TYPES.has(mediaType)) {
        response.res.destroy();
        throw new FetchError('unsupported_type', `不支持的内容类型：${mediaType}`);
      }
      let charset: string | null = null;
      for (const param of params) {
        const match = /^\s*charset\s*=\s*"?([^";]+)"?\s*$/i.exec(param);
        if (match !== null) charset = match[1]!.trim().toLowerCase();
      }

      const body = await readBody(response.res, response.headers['content-encoding'], controller.signal);
      return { finalUrl: current.toString(), status: response.status, contentType, charset, body };
    }
  } catch (err) {
    if (err instanceof FetchError) throw err;
    if (controller.signal.aborted || isAbortError(err)) {
      if (timedOut) throw new FetchError('timeout');
      if (externalAborted) throw new FetchError('aborted');
      throw new FetchError('timeout');
    }
    throw new FetchError('network', `网络错误：${errorMessage(err)}`);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
