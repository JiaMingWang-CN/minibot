import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractContent } from '../src/web/extract.ts';
import type { SafeFetchResult } from '../src/web/safe-fetch.ts';

function result(contentType: string, body: Buffer | string, charset: string | null = null): SafeFetchResult {
  return {
    finalUrl: 'https://example.com/page',
    status: 200,
    contentType,
    charset,
    body: Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'),
  };
}

test('提取文章：标题正确，Markdown 含正文且不含导航', () => {
  const html = `<!doctype html><html><head><title>真实标题</title></head><body>
    <nav><a href="/">导航首页</a><a href="/about">关于我们</a></nav>
    <article><h1>真实标题</h1>
      <p>这是第一段正文，描述文章的主要内容，足够长以便阅读。</p>
      <p>这是第二段正文，补充更多细节信息，让文章显得完整。</p>
    </article>
    <footer>版权所有</footer></body></html>`;
  const { title, markdown } = extractContent(result('text/html', html));
  assert.equal(title, '真实标题');
  assert.ok(markdown.includes('第一段正文'));
  assert.ok(markdown.includes('第二段正文'));
  assert.equal(markdown.includes('导航首页'), false);
});

test('GBK 页面：按响应头字符集正确解码', () => {
  const body = Buffer.concat([
    Buffer.from('<html><head><title>中文</title></head><body><p>'),
    Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xd5, 0xfd, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]),
    Buffer.from('</p></body></html>'),
  ]);
  const { markdown } = extractContent(result('text/html; charset=gbk', body));
  assert.ok(markdown.includes('中文正文测试'));
});

test('meta charset：没有头部字符集时按 meta 解码', () => {
  const body = Buffer.concat([
    Buffer.from('<html><head><meta charset="shift_jis"><title>x</title></head><body><p>'),
    Buffer.from([0x82, 0xa0]),
    Buffer.from('</p></body></html>'),
  ]);
  const { markdown } = extractContent(result('text/html', body));
  assert.ok(markdown.includes('あ'));
});

test('JSON：格式化后包进 json 代码块', () => {
  const { markdown } = extractContent(result('application/json', '{"a":1,"b":[2,3]}'));
  assert.ok(markdown.includes('```json'));
  assert.ok(markdown.includes('"a": 1'));
});

test('纯文本与 Markdown 原样返回', () => {
  assert.deepEqual(extractContent(result('text/plain', '  hello  ')), { title: '', markdown: 'hello' });
  assert.deepEqual(extractContent(result('text/markdown', '# 标题')), { title: '', markdown: '# 标题' });
});
