import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER_SRC = fileURLToPath(new URL('../../../apps/renderer/src/', import.meta.url));
const LANGUAGE_PACK = path.join(RENDERER_SRC, 'i18n.ts');

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectSourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name) && full !== LANGUAGE_PACK) files.push(full);
  }
  return files;
}

/** 去掉注释（块注释、JSX 注释、行注释）；代码注释允许写中文 */
function stripComments(source: string): string {
  return source
    .replace(/^﻿/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

test('stripComments 只去注释，不动字符串里的 URL', () => {
  assert.equal(stripComments('const a = 1; // 说明'), 'const a = 1; ');
  assert.equal(stripComments('{/* 说明 */}<b/>'), '{}<b/>');
  assert.equal(stripComments("const u = 'http://x/y';"), "const u = 'http://x/y';");
  assert.equal(stripComments('﻿// 说明\r\nconst b = 2; // 说明\r\n'), '\nconst b = 2; \n');
});

test('界面文字只在语言包 i18n.ts 里：其余渲染端源码除注释外没有中日韩字符', async () => {
  const files = await collectSourceFiles(RENDERER_SRC);
  assert.ok(files.length > 0);
  const offenders: string[] = [];
  for (const file of files) {
    const code = stripComments(await fs.readFile(file, 'utf8'));
    code.split(/\r?\n/).forEach((line, i) => {
      if (/[一-鿿]/.test(line)) offenders.push(`${path.relative(RENDERER_SRC, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
