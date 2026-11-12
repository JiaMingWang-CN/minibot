// 构建时把收集点地址写进 dist/build-info.json：源码里没有默认值，
// 未设置 MINIBOT_COLLECT_URL 时写入空串（主进程当作 null 传给内核）。

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'apps/desktop/dist');
const collectUrl = (process.env.MINIBOT_COLLECT_URL ?? '').trim();

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'build-info.json'), `${JSON.stringify({ collectUrl }, null, 2)}\n`, 'utf8');
