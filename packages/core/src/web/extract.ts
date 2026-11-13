import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import type { SafeFetchResult } from './safe-fetch.ts';

/** 取字符集：响应头优先，其次 HTML 前 2048 字节里的 meta，最后 UTF-8 */
function detectCharset(result: SafeFetchResult): string {
  if (result.charset !== null && result.charset.length > 0) return result.charset;
  // 头里没有 charset 参数时，也从 Content-Type 里找一遍
  const fromHeader = /charset\s*=\s*"?([^";]+)"?/i.exec(result.contentType);
  if (fromHeader !== null) return fromHeader[1]!.trim().toLowerCase();
  const head = result.body.subarray(0, 2048);
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return 'utf-8';
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';
  const ascii = head.toString('latin1');
  for (const tag of ascii.match(/<meta\b[^>]*>/gi) ?? []) {
    const match = /charset\s*=\s*["']?\s*([a-zA-Z0-9_.:-]+)/i.exec(tag);
    if (match !== null) return match[1]!.trim().toLowerCase();
  }
  return 'utf-8';
}

function decodeBody(result: SafeFetchResult): string {
  const label = detectCharset(result);
  try {
    return new TextDecoder(label).decode(result.body);
  } catch {
    return new TextDecoder('utf-8').decode(result.body);
  }
}

function mediaTypeOf(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });

function htmlToContent(html: string): { title: string; markdown: string } {
  const { document } = parseHTML(html);
  let title = '';
  let contentHtml = '';
  try {
    const reader = new Readability(document as never, { charThreshold: 0 });
    const article = reader.parse();
    title = (article?.title ?? document.title ?? '').trim();
    contentHtml = article?.content ?? '';
  } catch {
    // 正文提取失败时退回整页
  }
  if (contentHtml.trim().length === 0) contentHtml = document.body?.innerHTML ?? html;
  if (title.length === 0) title = (document.title ?? '').trim();
  return { title, markdown: turndown.turndown(contentHtml).trim() };
}

/** 把安全抓取的结果转成标题与 Markdown 正文 */
export function extractContent(result: SafeFetchResult): { title: string; markdown: string } {
  const mediaType = mediaTypeOf(result.contentType);
  const text = decodeBody(result);

  if (mediaType === 'text/plain' || mediaType === 'text/markdown') {
    return { title: '', markdown: text.trim() };
  }
  if (mediaType === 'application/json') {
    let formatted = text;
    try {
      formatted = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // 不是合法 JSON 就原样
    }
    return { title: '', markdown: `\`\`\`json\n${formatted}\n\`\`\`` };
  }
  return htmlToContent(text);
}
