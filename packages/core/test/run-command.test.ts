import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../src/tools/run-command.ts';
import { decodeOutput, encodePowerShell } from '../src/tools/process.ts';

const isWin = process.platform === 'win32';

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minibot-cmd-'));
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readPid(file: string): Promise<number> {
  const text = await fs.readFile(file, 'utf8');
  const pid = Number.parseInt(text.trim(), 10);
  assert.ok(Number.isFinite(pid) && pid > 0, `pid 文件内容无效：${text}`);
  return pid;
}

async function assertProcessDead(pid: number): Promise<void> {
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
    else throw err;
  }
  assert.equal(alive, false, `进程 ${pid} 仍然存活`);
}

function longRunningCommand(pidFile: string): string {
  if (isWin) {
    const script =
      "$psi = New-Object System.Diagnostics.ProcessStartInfo; " +
      "$psi.FileName = 'powershell.exe'; " +
      "$psi.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -Command \"Start-Sleep -Seconds 30\"'; " +
      '$psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; ' +
      '$psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; ' +
      '$child = [System.Diagnostics.Process]::Start($psi); ' +
      `Set-Content -Path ${psQuote(pidFile)} -Encoding ascii -Value $child.Id; ` +
      'Start-Sleep -Seconds 30';
    return script;
  }
  return `sleep 30 & echo $! > ${psQuote(pidFile)}; wait`;
}

test('返回退出码、耗时与输出', async () => {
  const root = await tmpRoot();
  const result = await runCommand(
    { cwd: root, outputsDir: path.join(root, 'outputs'), signal: new AbortController().signal },
    { command: 'echo hi' },
  );
  assert.equal(result.isError, false);
  assert.ok(result.content.includes('退出码: 0'));
  assert.ok(result.content.includes('超时: 否'));
  assert.ok(result.content.includes('耗时:'));
  assert.ok(result.content.includes('hi'));
});

test('中文与空格路径、中文输出（Review Focus 3）', async () => {
  const root = await tmpRoot();
  const cwd = path.join(root, '中文 目录');
  await fs.mkdir(cwd, { recursive: true });
  const command = isWin
    ? "[Console]::Out.WriteLine((Get-Location).Path); [Console]::Out.WriteLine('你好')"
    : "pwd; printf '你好\\n'";
  const result = await runCommand(
    { cwd, outputsDir: path.join(root, 'outputs'), signal: new AbortController().signal },
    { command },
  );
  assert.equal(result.isError, false);
  assert.ok(result.content.includes('中文 目录'));
  assert.ok(result.content.includes('你好'));
});

test('超时结束整个进程树', async () => {
  const root = await tmpRoot();
  const pidFile = path.join(root, 'pid.txt');
  const started = Date.now();
  const result = await runCommand(
    { cwd: root, outputsDir: path.join(root, 'outputs'), signal: new AbortController().signal },
    { command: longRunningCommand(pidFile), timeout_ms: 1000 },
  );
  assert.equal(result.isError, false);
  assert.ok(result.content.includes('超时: 是'));
  const pid = await readPid(pidFile);
  const remaining = 2500 - (Date.now() - started);
  if (remaining > 0) await sleep(remaining);
  await assertProcessDead(pid);
});

test('abort 结束进程树', async () => {
  const root = await tmpRoot();
  const pidFile = path.join(root, 'pid.txt');
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), 300);
  try {
    await runCommand(
      { cwd: root, outputsDir: path.join(root, 'outputs'), signal: controller.signal },
      { command: longRunningCommand(pidFile) },
    );
  } finally {
    clearTimeout(timer);
  }
  assert.ok(Date.now() - started < 10000, 'abort 后应尽快返回');
  const pid = await readPid(pidFile);
  const remaining = 2500 - (Date.now() - started);
  if (remaining > 0) await sleep(remaining);
  await assertProcessDead(pid);
});

test('输出超过 30000 字符：保留头尾各 15000，完整输出写入 outputs/', async () => {
  const root = await tmpRoot();
  const outputsDir = path.join(root, 'outputs');
  const command = isWin
    ? "[Console]::Out.Write('x' * 40000)"
    : "head -c 40000 /dev/zero | tr '\\0' x";
  const result = await runCommand(
    { cwd: root, outputsDir, signal: new AbortController().signal },
    { command },
  );
  assert.equal(result.isError, false);
  assert.ok(result.content.includes('[已省略中间 10000 个字符，完整输出见 '));
  const files = await fs.readdir(outputsDir);
  assert.equal(files.length, 1);
  const full = await fs.readFile(path.join(outputsDir, files[0]!), 'utf8');
  assert.equal(full.length, 40000);
  assert.equal(full, 'x'.repeat(40000));
});

test('timeout_ms 超过上限按 600000 处理', async () => {
  const root = await tmpRoot();
  const command = isWin ? "[Console]::Out.Write('ok')" : 'printf ok';
  const result = await runCommand(
    { cwd: root, outputsDir: path.join(root, 'outputs'), signal: new AbortController().signal },
    { command, timeout_ms: 700000 },
  );
  assert.equal(result.isError, false);
  assert.ok(result.content.includes('超时: 否'));
  assert.ok(result.content.includes('ok'));
});

test('工作目录不存在 → isError，content 含 "工作目录不存在"', async () => {
  const root = await tmpRoot();
  const result = await runCommand(
    {
      cwd: path.join(root, 'missing'),
      outputsDir: path.join(root, 'outputs'),
      signal: new AbortController().signal,
    },
    { command: 'echo hi' },
  );
  assert.equal(result.isError, true);
  assert.ok(result.content.includes('工作目录不存在'));
});

test('decodeOutput：合法 UTF-8 原样解码；非法 UTF-8 按 fallback 解码', () => {
  assert.equal(decodeOutput(Buffer.from('你好', 'utf8'), 'gbk'), '你好');
  assert.equal(decodeOutput(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), 'gbk'), '你好');
});

test('encodePowerShell 产出 -EncodedCommand 的 UTF-16LE Base64', () => {
  const args = encodePowerShell('echo hi');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const decoded = Buffer.from(args[3]!, 'base64').toString('utf16le');
  assert.ok(decoded.includes('echo hi'));
  assert.ok(decoded.includes('UTF8Encoding'));
});
