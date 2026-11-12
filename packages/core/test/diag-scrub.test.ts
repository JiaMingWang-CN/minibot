import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactLike, scrubPaths, scrubStack } from '../src/diag/scrub.ts';

const ctx = {
  home: 'C:\\Users\\Alice',
  workspaces: ['C:\\Users\\Alice\\proj'],
  user: 'Alice',
  host: 'ALICE-PC',
};

test('scrubPaths: 工作区与主目录', () => {
  assert.equal(scrubPaths('C:\\Users\\Alice\\proj\\a.ts', ctx), '<workspace>\\a.ts');
  assert.equal(scrubPaths('c:/users/alice/x', ctx), '~/x');
  // 正反斜杠、JSON 转义后的双反斜杠都处理
  assert.equal(scrubPaths('C:/Users/Alice/proj/src/b.ts', ctx), '<workspace>/src/b.ts');
  assert.equal(scrubPaths('C:\\\\Users\\\\Alice\\\\proj\\\\c.ts', ctx), '<workspace>\\\\c.ts');
  // 句中出现
  assert.equal(scrubPaths('读取 C:\\Users\\Alice\\notes.md 失败', ctx), '读取 ~\\notes.md 失败');
});

test('scrubPaths: 不误伤前缀相同的其他目录', () => {
  assert.equal(scrubPaths('C:\\Users\\Alice2\\x', ctx), 'C:\\Users\\Alice2\\x');
  assert.equal(scrubPaths('C:\\Users\\Alice\\proj2\\x', ctx), '~\\proj2\\x');
});

test('scrubPaths: 用户名与主机名', () => {
  assert.equal(scrubPaths('user alice on ALICE-pc', ctx), 'user <user> on <host>');
  // 作为其他单词的一部分不替换
  assert.equal(scrubPaths('malice', ctx), 'malice');
});

test('scrubPaths: POSIX 路径区分大小写', () => {
  const posix = { home: '/home/bob', workspaces: ['/home/bob/w'], user: 'carol', host: 'box1' };
  assert.equal(scrubPaths('/home/bob/w/a.ts and /home/bob/z', posix), '<workspace>/a.ts and ~/z');
  assert.equal(scrubPaths('/HOME/BOB/z', posix), '/HOME/BOB/z');
});

test('scrubPaths: 过短的用户名不替换', () => {
  assert.equal(scrubPaths('a b', { home: '', workspaces: [], user: 'a', host: '' }), 'a b');
});

test('scrubStack: 只留函数名与相对位置', () => {
  const stack = [
    'Error: boom 含有用户内容 C:\\Users\\Alice\\secret.txt',
    '    at start (C:\\Program Files\\minibot\\resources\\app.asar\\dist\\main.cjs:10:5)',
    '    at async Object.run (C:\\Users\\Alice\\proj\\packages\\core\\src\\kernel.ts:200:9)',
    '    at C:\\Users\\Alice\\other\\script.js:3:1',
    '    at node:internal/process/task_queues:105:5',
    '    at x (file:///C:/Program%20Files/minibot/resources/app.asar/dist/a.js:1:2)',
  ].join('\n');
  const out = scrubStack(stack, ctx);
  assert.match(out, /app\.asar\/dist\/main\.cjs:10:5/);
  assert.match(out, /packages\/core\/src\/kernel\.ts:200:9/);
  assert.match(out, /at script\.js:3:1/);
  assert.match(out, /node:internal\/process\/task_queues:105:5/);
  assert.match(out, /app\.asar\/dist\/a\.js:1:2/);
  assert.match(out, /at start \(/);
  assert.match(out, /at async Object\.run \(/);
  assert.doesNotMatch(out, /Alice|Program Files|C:|boom/);
});

test('scrubStack: 长度封顶 4096 且按整行截断', () => {
  const frames = Array.from({ length: 500 }, (_, i) => `    at fn${i} (/srv/app/packages/core/src/f${i}.ts:1:1)`).join('\n');
  const out = scrubStack(frames, ctx);
  assert.ok(out.length <= 4096);
  assert.ok(out.endsWith(')'));
  assert.match(out, /^at fn0 /m);
});

test('scrubStack: 没有栈帧返回空串', () => {
  assert.equal(scrubStack('just a message', ctx), '');
  assert.equal(scrubStack('', ctx), '');
});

test('redactLike: 形态过滤', () => {
  assert.equal(redactLike('key sk-abcdef1234567890 end'), 'key [REDACTED] end');
  assert.equal(redactLike('sk-ant-api03-AbCdEf_123-456xyz'), '[REDACTED]');
  assert.equal(redactLike('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789'), 'Authorization: [REDACTED]');
  assert.equal(redactLike('t=' + 'aB3'.repeat(12)), 't=[REDACTED]');
  // 普通文本、短串、纯字母长词、已脱敏标记保持不变
  assert.equal(redactLike('hello world 12345'), 'hello world 12345');
  assert.equal(redactLike('sk-short'), 'sk-short');
  assert.equal(redactLike('a'.repeat(40)), 'a'.repeat(40));
  assert.equal(redactLike('[REDACTED_API_KEY] ok'), '[REDACTED_API_KEY] ok');
  assert.equal(redactLike('C:\\Users\\x\\file.ts:10:5'), 'C:\\Users\\x\\file.ts:10:5');
});

test('redactLike: UUID 与 bot id 不当密钥抹掉', () => {
  const id = '8988e460-20cf-4194-bcd3-c45c2a3fe2c2';
  assert.equal(redactLike(`bot ${id} failed`), `bot ${id} failed`);
  const path = '\\Users\\x\\workspaces\\' + id;
  assert.equal(redactLike(path), path);
});

test('scrubPaths: 含 UUID 的默认工作区路径替换成 <workspace>', () => {
  const id = '8988e460-20cf-4194-bcd3-c45c2a3fe2c2';
  const ws = 'C:\\Users\\Alice\\.minibot\\workspaces\\' + id;
  assert.equal(
    scrubPaths(ws + '\\a.ts', {
      home: 'C:\\Users\\Alice',
      workspaces: [ws],
      user: 'Alice',
      host: 'PC',
    }),
    '<workspace>\\a.ts',
  );
});
