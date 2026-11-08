import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER_DIR = new URL('../../../apps/desktop/src/renderer/', import.meta.url);

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'i18n') continue;
      files.push(...(await collectTsFiles(full)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

test('除 i18n 目录外，渲染进程源码里没有中日韩字符', async () => {
  const dir = fileURLToPath(RENDERER_DIR);
  const files = await collectTsFiles(dir);
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    assert.equal(
      /[\u4e00-\u9fff]/.test(text),
      false,
      `发现中日韩字符：${file}`,
    );
  }
});
