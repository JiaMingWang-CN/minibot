// 把根 package.json 的 version 同步到桌面端与手机端，并输出安卓的 versionName / versionCode。
// versionCode = major*10000 + minor*100 + patch（0.1.0 → 100）。

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['apps/desktop/package.json', 'apps/mobile/package.json'];

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJson(file, data) {
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

const version = (await readJson(path.join(ROOT, 'package.json'))).version;
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
if (match === null) throw new Error(`根 package.json 的 version 不是 X.Y.Z：${String(version)}`);
const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
const versionCode = major * 10000 + minor * 100 + patch;

for (const rel of TARGETS) {
  const file = path.join(ROOT, rel);
  const pkg = await readJson(file);
  if (pkg.version === version) continue;
  pkg.version = version;
  await writeJson(file, pkg);
}

console.log(`versionName=${version}`);
console.log(`versionCode=${versionCode}`);
