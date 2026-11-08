import { cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'apps', 'desktop', 'static');
const target = path.join(root, 'apps', 'desktop', 'dist', 'static');
await cp(source, target, { recursive: true });

const rendererSource = path.join(root, 'apps', 'desktop', 'dist', 'renderer');
const rendererTarget = path.join(target, 'assets', 'renderer');
await cp(rendererSource, rendererTarget, { recursive: true });
