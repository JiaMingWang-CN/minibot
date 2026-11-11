import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';
import { Kernel, KernelError } from '../kernel.ts';
import { HttpError, dispatchApi, type ApiResponse } from './dispatch.ts';

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  let size = 0;
  let tooLarge = false;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) {
      tooLarge = true;
    } else {
      chunks.push(buffer);
    }
  }
  if (tooLarge) throw new HttpError(413, 'payload_too_large', `请求体超过 ${Math.round(maxBytes / 1024 / 1024)}MB`);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) throw new KernelError('invalid', '请求体为空');
  try {
    return JSON.parse(text);
  } catch {
    throw new KernelError('invalid', '请求体不是合法 JSON');
  }
}

function writeResponse(res: ServerResponse, response: ApiResponse): void {
  if ('json' in response) {
    sendJson(res, response.status, response.json);
    return;
  }
  res.writeHead(response.status, {
    'content-type': response.contentType,
    'content-length': String(response.bytes.length),
    ...response.headers,
  });
  res.end(response.bytes);
}

export async function handleApi(
  kernel: Kernel,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const response = await dispatchApi(kernel, {
    method: req.method ?? 'GET',
    url,
    readBody: (maxBytes) => readJsonBody(req, maxBytes),
  });
  writeResponse(res, response);
}
