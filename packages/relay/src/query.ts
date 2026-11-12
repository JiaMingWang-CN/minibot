import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// 收集库查询：node dist/query.js <events|feedback|feedback-show|install> [参数] [--db <path>]
// 输出纯文本表格。

const DAY_MS = 24 * 3600_000;

const USAGE = `用法：
  query events [--days N] [--name X]   按 版本/事件名 计数（默认最近 7 天）
  query feedback [--limit N]           最近的反馈列表（默认 20 条）
  query feedback-show <id>             单条反馈的完整内容（含日志）
  query install <installId>            某个安装的事件与反馈
数据库：--db <path>，或环境变量 RELAY_COLLECT_DB`;

type Row = Record<string, unknown>;

function cell(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ');
}

// 中日文字符占两列宽
function width(text: string): number {
  let w = 0;
  for (const ch of text) w += (ch.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1;
  return w;
}

function table(headers: string[], body: string[][]): string {
  const all = [headers, ...body];
  const widths = headers.map((_, i) => Math.max(...all.map((row) => width(row[i] ?? ''))));
  return all
    .map((row) => row.map((c, i) => c + ' '.repeat(widths[i]! - width(c))).join('  ').trimEnd())
    .join('\n');
}

const time = (ms: unknown): string => new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 19);

function positive(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} 必须是正数`);
  return n;
}

export function runQuery(argv: string[], env: NodeJS.ProcessEnv, now: () => number = Date.now): string {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      days: { type: 'string' },
      name: { type: 'string' },
      limit: { type: 'string' },
    },
  });
  const [command, arg] = positionals;
  const dbPath = values.db ?? env['RELAY_COLLECT_DB'];
  if (command === undefined) throw new Error(USAGE);
  if (dbPath === undefined || dbPath === '') throw new Error('需要 --db <path> 或环境变量 RELAY_COLLECT_DB');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    switch (command) {
      case 'events': {
        const since = now() - positive(values.days, 7, '--days') * DAY_MS;
        const rows = db
          .prepare(
            `SELECT app_version, name, count(*) AS n FROM events
             WHERE received_at >= ? AND (? IS NULL OR name = ?)
             GROUP BY app_version, name ORDER BY app_version DESC, n DESC, name`,
          )
          .all(since, values.name ?? null, values.name ?? null) as Row[];
        return table(['版本', '事件', '次数'], rows.map((r) => [cell(r['app_version']), cell(r['name']), cell(r['n'])]));
      }
      case 'feedback': {
        const limit = Math.floor(positive(values.limit, 20, '--limit'));
        const rows = db.prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT ?').all(limit) as Row[];
        return table(
          ['id', '时间', '平台', '版本', '联系方式', '描述'],
          rows.map((r) => [
            cell(r['id']),
            time(r['received_at']),
            cell(r['platform']),
            cell(r['app_version']),
            cell(r['contact']),
            cell(r['description']).slice(0, 40),
          ]),
        );
      }
      case 'feedback-show': {
        if (arg === undefined) throw new Error(USAGE);
        const r = db.prepare('SELECT * FROM feedback WHERE id = ?').get(Number(arg)) as Row | undefined;
        if (r === undefined) throw new Error(`没有 id 为 ${arg} 的反馈`);
        return [
          `id: ${cell(r['id'])}`,
          `时间: ${time(r['received_at'])}`,
          `安装: ${cell(r['install_id'])}`,
          `平台: ${cell(r['platform'])}  版本: ${cell(r['app_version'])}  系统: ${cell(r['os'])}`,
          `联系方式: ${cell(r['contact'])}`,
          '',
          '描述:',
          String(r['description']),
          '',
          '日志:',
          String(r['logs'] ?? '（无）'),
        ].join('\n');
      }
      case 'install': {
        if (arg === undefined) throw new Error(USAGE);
        const events = db
          .prepare('SELECT * FROM events WHERE install_id = ? ORDER BY id DESC LIMIT 100')
          .all(arg) as Row[];
        const feedback = db.prepare('SELECT * FROM feedback WHERE install_id = ? ORDER BY id DESC').all(arg) as Row[];
        return [
          `事件（最近 ${events.length} 条）`,
          table(
            ['时间', '版本', '类型', '事件', '数据'],
            events.map((r) => [time(r['received_at']), cell(r['app_version']), cell(r['kind']), cell(r['name']), cell(r['data_json'])]),
          ),
          '',
          `反馈（${feedback.length} 条）`,
          table(
            ['id', '时间', '描述'],
            feedback.map((r) => [cell(r['id']), time(r['received_at']), cell(r['description']).slice(0, 40)]),
          ),
        ].join('\n');
      }
      default:
        throw new Error(USAGE);
    }
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(runQuery(process.argv.slice(2), process.env));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
