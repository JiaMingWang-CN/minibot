# 诊断数据、反馈与应用内更新 Implementation Plan

> **For agentic workers:** Implement this plan task-by-task, in order. Each task's requirements include the Global Constraints below; each task's Interfaces block tells you the names and types neighboring tasks use. The plan gives approach and constraints only — you write the tests and the code. Steps use checkbox (`- [ ]`) syntax for tracking — tick each one as it is done.

**Goal:** 中继可选收集诊断与反馈；电脑端与安卓端写本地日志、上传脱敏事件、提交反馈、协商协议版本，并从 GitHub Releases 应用内更新。

**Architecture:** 中继进程改为自建 `http.Server`，WebSocket 挂在 upgrade 上，`RELAY_COLLECT_DB` 设置时启用 `/collect/v1/*` 写 SQLite。电脑端的日志、事件队列、上传、反馈都在内核（`packages/core/src/diag/`）里，渲染端经本机 API 使用；安卓端在 Kotlin 原生层实现同样的一套（`app.minibot.mobile.diag`），网页层经插件方法使用。更新：桌面主进程用 electron-updater，安卓原生层查 GitHub Release API 下载 APK。

**Tech Stack:** Node 24（`node:sqlite`、`node:http`、`node:zlib`）、`ws`、Electron 45 + electron-builder 26 + electron-updater、React 19 + Tailwind v4、Kotlin + OkHttp + Capacitor 8、GitHub Actions。

**Spec:** `docs/specs/2026-11-12-diagnostics-feedback-update-design.md`

## Global Constraints

- 上传内容（事件、反馈、日志附件）永不含：消息正文、bot 人设、记忆内容、API Key、中继口令、配对 psk / 私钥、图片内容。日志本身就不写这些。
- 事件只允许白名单字段：枚举值、数字、布尔、错误类型 / 错误码、脱敏后的堆栈、模型 id、服务 presetId（自定义服务只报 `format`，不报 `baseUrl`）。不允许自由文本字段。`data` 的值只能是 string / number / boolean / null；string 默认 ≤ 64 字，唯一例外是键 `stack`（脱敏后的堆栈）：≤ 4096 字，允许 `\n`，其他控制字符拒绝。中继与客户端用同一规则。
- 收集点地址源码里无默认值；只由构建时环境变量 `MINIBOT_COLLECT_URL` 写入；为空时上传与反馈整体关闭（反馈入口隐藏）。
- 同意状态三值 `unset` / `on` / `off`：`unset` 只入队不上传；`off` 不入队并清空队列；反馈不受此开关限制。
- 中继：不设 `RELAY_COLLECT_DB` 时 `/collect/*` 返回 `404` 且不创建任何文件；`/v1` WebSocket 行为与现有测试完全不变；收集路径的任何错误不得影响转发。
- 本地日志：JSON Lines，每行字段 `ts, level(info|warn|error), area, msg, ...fields`；电脑 `MINIBOT_HOME/logs/minibot-YYYY-MM-DD.log` 保留 7 天、总量 ≤ 50 MB；手机 `files/logs/` 保留 7 天、≤ 20 MB；超出删最旧。
- 版本号单一来源：根 `package.json` 的 `version`；`versionCode = major*10000 + minor*100 + patch`。
- 界面文案全部进 `apps/renderer/src/i18n.ts`（手机网页层通过 `@renderer/i18n` 共用）；视觉遵守 `.claude/CLAUDE.md`（语义 token、`src/ui/` 浮层与 `recipes.ts`）。
- 安卓签名只用 `MINIBOT_KEYSTORE*`（CI 中由 Secrets `MINIBOT_KEYSTORE_BASE64`、`MINIBOT_KEYSTORE_PASSWORD`、`MINIBOT_KEY_ALIAS`、`MINIBOT_KEY_PASSWORD` 还原），签名材料不进仓库。
- 新增依赖锁定精确版本（与仓库现有写法一致）；使用前按用户全局 CLAUDE.md 用 Context7 或探针脚本核对 API。

## Review Focus

- 离线或收集点不可达很久 → 队列封顶 1000 条丢最旧，重试退避，不阻塞启动、不刷日志。
- 日志目录不可写 / 磁盘满 → 日志与事件静默降级，应用照常工作，不抛到调用方。
- 用户在 `unset` 状态下一直不表态（关掉提示）→ 永不上传；下次启动仍提示，队列不超上限。
- 收集端收到畸形 gzip、超大解压炸弹、错误字段类型 → 返回 `400`/`413`，不崩进程，不影响 WebSocket。
- 更新下载中途断网 / 哈希不符 / APK 被替换 → 删除半成品，提示失败，不调起安装。

---

### Task 1: 中继收集接口

**Files:**
- Modify: `packages/relay/src/relay.ts`, `packages/relay/src/main.ts`, `packages/relay/README.md`
- Create: `packages/relay/src/collect.ts`, `packages/relay/src/query.ts`
- Test: `packages/relay/test/collect.test.ts`

**Interfaces:**
- Produces: `RelayOptions.collect?: { dbPath: string; maxBytes: number }`
- Produces: `createCollector(o: { dbPath: string; maxBytes: number; now: () => number; log: (m: string) => void }): { handle(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void>; close(): void }`
- Produces（线协议，Task 3/7 使用）：events body `{ installId: string, platform: 'win32'|'android', appVersion: string, os: string, events: { ts: number, kind: 'start'|'error'|'crash'|'metric'|'update', name: string, data: object }[] }`；feedback body `{ installId, platform, appVersion, os, description: string, contact?: string, logs?: string }`

**思路:**
- `startRelay` 改为先建 `http.createServer`，`WebSocketServer({ noServer: true, ... })`，在 `upgrade` 事件中仅对 `/v1` 路径 `handleUpgrade`，其他路径销毁 socket。普通 HTTP 请求：`collect` 已配置且路径以 `/collect/v1/` 开头交给 collector，否则 `404`。
- IP 取值复用现有 `clientIp(req, trustProxy)`。
- collector：按 `content-encoding: gzip` 用 `zlib.gunzip` 带 `maxOutputLength` 解压；按 Global/约束校验字段；单事务批量插入；写库前用 `PRAGMA page_count * page_size` 判断是否超 `maxBytes`。每个请求处理包在 try/catch 内，异常记一行计数日志返回 `500`。
- 限流用滑动窗口 Map（与现有 `ipHits` 同法）并定期清理过期键；feedback 另有按 `installId` 的日计数。
- `main.ts` 读取 `RELAY_COLLECT_DB` 与 `RELAY_COLLECT_MAX_MB`（默认 `2048`）。
- `query.ts`：子命令 `events [--days N] [--name X]`（按 `app_version`,`name` 计数）、`feedback [--limit N]`、`feedback-show <id>`、`install <installId>`，参数 `--db <path>` 或读 `RELAY_COLLECT_DB`。输出纯文本表格。
- README 增加“诊断收集（可选）”一节，含两个环境变量、存什么、不设时不落盘的说明、`query` 用法。

**约束:**
- 状态码：成功 `204`；格式错 `400`；超限 `413`；限流 `429`；未开启/未知路径 `404`；存储满 `507`；内部错 `500`。
- events：原始 body ≤ 256 KB，解压后 ≤ 1 MB，≤ 200 条；feedback：原始 ≤ 2 MB，解压后 ≤ 8 MB；`description` ≤ 5000 字、`contact` ≤ 200 字。
- 限流：每 IP 每分钟 events 30 次、feedback 3 次；每 `installId` 每天 feedback 20 条。
- 表：`events(id, received_at, install_id, platform, app_version, os, kind, name, data_json)`、`feedback(id, received_at, install_id, platform, app_version, os, description, contact, logs)`，`schemaVersion` 1（`PRAGMA user_version`）。
- 中继日志不打印任何收集内容，只打印计数与错误。
- 现有 `packages/relay/test/*.test.ts` 不修改且全部通过。

**验收:**
- `collect disabled`：未配置 collect，`POST /collect/v1/events` → `404`，临时目录内无新文件。
- `events accepted`：合法 3 条事件（gzip 与非 gzip 各一次）→ `204`，表内 6 行，字段一一对应。
- `events invalid`：`kind` 为 `'x'` 或缺 `installId` → `400`；201 条 → `413`；解压后 > 1 MB 的 gzip → `413`；非法 gzip → `400`。
- `feedback accepted`：含 `logs` 的反馈 → `204`，`feedback-show` 输出含描述与日志。
- `rate limit`：同一 IP 第 31 次 events（同一分钟，注入 `now`）→ `429`；同一 `installId` 当天第 21 条反馈 → `429`。
- `storage full`：`maxBytes` 设为当前库大小 → `507`。
- `ws unaffected`：collector 内部抛错（注入坏 dbPath 于请求期间）时，已建立的 pc/phone 转发仍收发正常。
- `unknown upgrade path`：对 `/other` 发起 WebSocket 升级 → 连接被拒。

- [x] **Step 1:** Write the tests in **验收**; run `node --test packages/relay/test/collect.test.ts` — expect FAIL.
- [x] **Step 2:** Implement per **思路** and **约束**.
- [x] **Step 3:** Run `npm test` — expect PASS（含现有中继测试）。
- [x] **Step 4:** Commit.

### Task 2: 内核日志与脱敏

**Files:**
- Create: `packages/core/src/diag/log.ts`, `packages/core/src/diag/scrub.ts`
- Modify: `packages/core/src/paths.ts`（加 `logsDir`）、`packages/core/src/kernel.ts`、`packages/core/src/model/client.ts`、`packages/core/src/tools/registry.ts`、`packages/core/src/remote/relay-link.ts`、`packages/core/src/remote/gateway.ts`、`packages/core/src/index.ts`
- Test: `packages/core/test/diag-log.test.ts`, `packages/core/test/diag-scrub.test.ts`

**Interfaces:**
- Produces: `type LogLevel = 'info' | 'warn' | 'error'`
- Produces: `interface DiagEvent { kind: 'start'|'error'|'crash'|'metric'|'update'; name: string; data: Record<string, string | number | boolean | null> }`
- Produces: `class DiagLog { constructor(o: { dir: string; secrets: SecretSet; now?: () => number; maxDays?: number; maxBytes?: number; pathContext?: () => { home: string; user: string; host: string; workspaces?: string[] } }); addWorkspace(dir: string): void; readonly secrets: SecretSet; write(level: LogLevel, area: string, msg: string, fields?: Record<string, unknown>, event?: DiagEvent): void; onEvent(cb: (e: DiagEvent & { ts: number }) => void): () => void; recent(sinceMs: number, maxBytes: number): Promise<string>; close(): Promise<void> }`
- Produces: `scrubPaths(text: string, ctx: { home: string; workspaces: string[]; user: string; host: string }): string`
- Produces: `scrubStack(stack: string, ctx: same): string`
- Produces: `redactLike(text: string): string`（形态过滤：`sk-…`、`Bearer …`、≥ 32 位的连续随机串 → `[REDACTED]`）
- Produces: `Kernel.diag: DiagLog`

**思路:**
- `write` 同步追加到内存缓冲，`setImmediate` 批量 `appendFile`，避免阻塞调用方；按日期切文件；启动与每次切文件时清理：先删超过 7 天的，再从最旧删到总量 ≤ 上限。
- 每行写盘前依次过 `secrets.redact`（已有 `SecretSet`，内核会把 API Key 与中继口令都登记进去——确认 RemoteStore 的中继口令也 `add` 进 `secretSet`）和 `redactLike`。
- `event` 参数存在时，对其 `data` 做白名单校验（值只能是 string/number/boolean/null，string 必须是短的枚举形态 ≤ 64 字且过 `scrubPaths`；与中继同规则，唯一例外是键 `stack`：≤ 4096 字、允许 `\n`、其他控制字符丢弃该字段，且 `stack` 必须是 `scrubStack` 后的结果），通过后带 `ts` 通知 `onEvent` 订阅者；不合规字段丢弃并在日志记一条 `warn`。
- 插桩点（area 名）：`model`（client.ts：presetId/format、模型 id、耗时、tokens、成功/失败、HTTP 状态；失败时完整日志写错误报文，事件 `error/model.request` 只带状态码与错误类别）、`tool`（registry.ts：工具名、退出码、耗时、拒绝/超时；完整日志写命令原文与路径，事件 `error/tool.<name>` 只带退出码与类别）、`remote`（relay-link.ts 与 gateway.ts：连接、断线原因、握手失败、配对结果，事件 `error/remote.connect`、`error/remote.pair`）、`app`（kernel init：事件 `start/app.start` 带 `appVersion`、`os`）。
- 内核 `Kernel.open` 新增可选 `appVersion?: string`（桌面传 `app.getVersion()`）。
- 绝不在任何插桩点传入消息正文、人设、记忆、图片。

**约束:**
- 日志文件名 `minibot-YYYY-MM-DD.log`（本地时区日期）；保留 7 天、总量 ≤ 50 MB。
- 写失败（目录不可写、磁盘满）静默丢弃，最多每分钟向 `console.warn` 报一次。
- `scrubPaths`：主目录 → `~`，工作区根 → `<workspace>`，用户名 → `<user>`，主机名 → `<host>`；Windows 路径大小写不敏感匹配，正反斜杠都处理。
- `scrubStack`：每帧只保留函数名与相对源码位置（去掉绝对前缀，保留 `packages/...` 或 `app.asar/...` 之后的部分）。

**验收:**
- `rotate by day`：注入 `now` 跨两天写入 → 两个文件，各含对应行。
- `retention`：预置 9 天的文件 → 启动后只剩最近 7 天；总量超 50 MB（测试中把上限设小）→ 删最旧直至达标。
- `secret redaction`：登记 Key `sk-test-1234567890abcdef` 后写含它的 msg → 文件中只见 `[REDACTED_API_KEY]`；未登记的 `Bearer abcdefghijklmnopqrstuvwxyz0123456789` → `[REDACTED]`。
- `event whitelist`：`data` 含对象值或 200 字字符串 → 该字段被丢弃，`onEvent` 收到的 data 不含它。
- `scrubPaths`：`C:\Users\Alice\proj\a.ts`（home `C:\Users\Alice`，workspace `C:\Users\Alice\proj`）→ `<workspace>\a.ts`；`c:/users/alice/x` → `~/x`。
- `scrubStack`：含 `C:\Program Files\minibot\resources\app.asar\dist\main.cjs:10:5` 的帧 → `app.asar/dist/main.cjs:10:5`。
- `unwritable dir`：日志目录是一个文件 → `write` 不抛错。
- `model failure instrumented`：用 kernel-harness 让模型返回 500 → 日志含 `area:"model"` 的 error 行，`onEvent` 收到 `error/model.request` 且 data 只有白名单字段。

- [x] **Step 1:** Write the tests in **验收**; run `node --test packages/core/test/diag-log.test.ts packages/core/test/diag-scrub.test.ts` — expect FAIL.
- [x] **Step 2:** Implement per **思路** and **约束**.
- [x] **Step 3:** Run `npm test` — expect PASS.
- [x] **Step 4:** Commit.

### Task 3: 内核事件队列、上传、同意状态与反馈 API

**Files:**
- Create: `packages/core/src/diag/uploader.ts`, `packages/core/src/diag/metrics.ts`
- Modify: `packages/core/src/config/types.ts`、`packages/core/src/config/config.ts`、`packages/core/src/db/db.ts`（新表 `diag_queue`）、`packages/core/src/kernel.ts`、`packages/core/src/server/dispatch.ts`、`packages/core/src/index.ts`
- Test: `packages/core/test/diag-uploader.test.ts`, `packages/core/test/diag-api.test.ts`

**Interfaces:**
- Consumes: `DiagLog`, `DiagEvent`, Task 1 线协议
- Produces: `AppConfig.diagnostics?: { consent: 'unset' | 'on' | 'off'; installId: string }`（缺省时迁移为 `{ consent: 'unset', installId: randomUUID() }`）
- Produces: `Kernel.open` 选项 `collectUrl?: string | null`、`fetch?: typeof fetch`
- Produces: API `GET /api/diagnostics` → `{ consent, available: boolean, appVersion: string }`；`PUT /api/diagnostics` body `{ consent: 'on' | 'off' }`；`GET /api/diagnostics/logs-preview` → `{ text: string }`；`POST /api/feedback` body `{ description: string; contact?: string; attachLogs: boolean }` → `{ ok: true }`；`POST /api/diagnostics/client-error` body `{ message: string; stack?: string; source: 'renderer' }` → `{ ok: true }`
- Produces: `KernelState.diagnosticsPrompt: boolean`（`consent === 'unset'` 且 `available`）

**思路:**
- `diag_queue(id, ts, kind, name, data_json)` 存 SQLite（内核已有 db）。订阅 `DiagLog.onEvent`：`consent === 'off'` 丢弃；否则入队，超 1000 条删最旧。
- metrics：内存中按 `presetId+model` 聚合模型请求次数、失败数、耗时样本，每小时把 p50/p95 生成一条 `metric/model.latency` 入队后清空。
- 上传循环：`collectUrl` 为空则不启动；`consent === 'on'` 时每 5 分钟或队列 ≥ 50 条触发；一次取 ≤ 200 条，gzip 后 POST `${collectUrl}/v1/events`，`204` 后删除这些行；失败指数退避（1 分钟起，上限 1 小时），`429`/`507` 同样退避；`400`/`413` 删除该批避免毒丸。
- `PUT consent off` 立即清空队列；`on` 立即触发一次上传。
- 反馈：`description` 必填 ≤ 5000、`contact` ≤ 200；`attachLogs` 时取 `diag.recent(24h, 1 MB)`（保留最新部分）；gzip POST `${collectUrl}/v1/feedback`；把收集端的非 2xx 映射成 `KernelError` 中文消息返回给界面（网络失败 / 被限流 / 服务暂不可用）。`collectUrl` 为空 → `404`。
- client-error：渲染端未捕获错误，经 `scrubStack` 后作为 `crash/renderer` 写日志与事件；message 只进完整日志，不进事件。
- 不给手机远程开放这些路由（远程请求走 gateway 白名单，确认未加入）。

**约束:**
- 队列上限 1000，批量 ≤ 200，阈值 50 条或 5 分钟；退避 1 分钟 → 1 小时封顶。
- 反馈附件：最近 24 小时，截断到 1 MB（保留最新部分）。
- 公共字段 `platform: 'win32'`、`appVersion`、`os`（`os.release()` 形态）、`installId`。
- `unset` 下绝不发出任何上传请求；反馈在任何同意状态下都可发送。

**验收:**
- `unset no upload`：consent `unset`，入队 60 条、推进时间 10 分钟 → 注入的 fetch 调用 0 次。
- `on uploads batch`：consent `on`，入队 60 条 → 一次 POST，body gzip 解开后 `events.length === 60`，成功后队列为空。
- `off clears`：队列 10 条时 PUT `off` → 队列 0 条，之后的事件不入队。
- `cap`：入队 1005 条 → 保留最新 1000。
- `backoff`：fetch 返回 503 → 1 分钟内不重试；连续失败后间隔不超过 1 小时。
- `poison batch`：fetch 返回 400 → 该批删除。
- `no collect url`：`collectUrl: null` → `GET /api/diagnostics` 的 `available` 为 false，`POST /api/feedback` → 404。
- `feedback attach`：`attachLogs: true` → 发出的 body 含 `logs` 且 ≤ 1 MB、来自最新日志；`false` → 无 `logs` 字段。
- `feedback validation`：空描述 → 400；5001 字 → 400。
- `config migrate`：无 `diagnostics` 的旧 config.json 加载后 consent 为 `unset` 且 `installId` 为 UUID，保存后再读不变。
- `remote denied`：经 gateway 的远程请求访问 `/api/feedback` → 被拒。

- [x] **Step 1:** Write the tests in **验收**; run `node --test packages/core/test/diag-uploader.test.ts packages/core/test/diag-api.test.ts` — expect FAIL.
- [x] **Step 2:** Implement per **思路** and **约束**.
- [x] **Step 3:** Run `npm test` — expect PASS.
- [x] **Step 4:** Commit.

### Task 4: 远程协议版本协商（电脑端）

**Files:**
- Modify: `packages/core/src/remote/gateway.ts`、`packages/core/src/remote/service.ts`（状态里带设备版本）、`apps/renderer/src/settings/PhonePage.tsx`、`apps/renderer/src/i18n.ts`
- Test: `packages/core/test/remote-version.test.ts`（用现有 `remote-phone.ts` 测试替身）

**Interfaces:**
- Produces: 常量 `REMOTE_PROTOCOL = 1`、`MIN_PHONE_PROTOCOL = 1`
- Produces（线协议，Task 8 使用）：握手后双方发 `{ t: 'version', app: string, protocol: number, minPeer: number }`
- Produces: `RemoteStatus.devices[i].appVersion: string | null`、`.compat: 'ok' | 'phone_outdated' | 'pc_outdated' | 'unknown'`

**思路:**
- 电脑端在发 `ready` 之后紧接着发 `version`。收到手机的 `version` 后按 `phone.protocol < MIN_PHONE_PROTOCOL` → `phone_outdated`、`REMOTE_PROTOCOL < phone.minPeer` → `pc_outdated` 判定；不兼容时该会话除 `version` 外的请求一律回错误 `incompatible`，并记日志与事件 `error/remote.version_mismatch`（data：两端 protocol 与 app 版本）。
- 手机不发 `version`（0.1.0）→ 视为 protocol 1、`compat: 'unknown'`，照常工作。
- PhonePage 设备列表显示手机版本，不兼容时显示提示文案。

**约束:**
- 文案（i18n）：`phone.compat.phone_outdated` = “手机端版本过旧，请在手机上更新 minibot”；`phone.compat.pc_outdated` = “电脑端版本过旧，请更新 minibot”。

**验收:**
- `ready then version`：手机替身完成握手 → 依次收到 `ready`、`version`（protocol 1）。
- `old phone`：替身不发 version → 请求照常成功，状态 `compat: 'unknown'`。
- `phone outdated`：把 `MIN_PHONE_PROTOCOL` 注入为 2，替身报 protocol 1 → 请求被拒 `incompatible`，状态 `phone_outdated`，产生 `remote.version_mismatch` 事件。
- `pc outdated`：替身报 `minPeer: 2` → 状态 `pc_outdated`。

- [x] **Step 1:** Write the tests in **验收**; run `node --test packages/core/test/remote-version.test.ts` — expect FAIL.
- [x] **Step 2:** Implement per **思路** and **约束**.
- [x] **Step 3:** Run `npm test` and `npm run build --workspace @minibot/renderer` — expect PASS.
- [x] **Step 4:** Commit.

### Task 5: 桌面端界面：同意、反馈、渲染端错误上报

**Files:**
- Modify: `apps/renderer/src/api.ts`、`apps/renderer/src/i18n.ts`、`apps/renderer/src/onboarding/Onboarding.tsx`、`apps/renderer/src/settings/SettingsDialog.tsx`、`apps/renderer/src/settings/GeneralPage.tsx`（或新增页，见思路）、`apps/renderer/src/main/MainScreen.tsx`、`apps/renderer/src/main.tsx`
- Create: `apps/renderer/src/settings/FeedbackDialog.tsx`、`apps/renderer/src/settings/DiagnosticsNotice.tsx`

**Interfaces:**
- Consumes: Task 3 的 API 与 `KernelState.diagnosticsPrompt`
- Produces: `Api.diagnostics()`, `Api.setDiagnostics(consent)`, `Api.logsPreview()`, `Api.sendFeedback(input)`, `Api.reportClientError(input)`

**思路:**
- 设置对话框新增页 `about`（`SettingsPageId` 加 `'about'`），内容：当前版本、“发送诊断信息”开关、“反馈问题”按钮（`available` 为 false 时隐藏开关与按钮）、以及 Task 6 的“检查更新”区（本任务先留版本行）。
- 初始化流程最后一步（`workspace`）的完成按钮上方加“发送诊断信息”勾选（默认勾选）+ 一句说明 + 可展开的完整清单；完成时调用 `setDiagnostics`。
- 主界面：`diagnosticsPrompt` 为真（老用户升级上来、或之前关掉提示）时显示一次不打扰的提示条，按钮“好的”(`on`) / “不发送”(`off`)，关闭（×）不改状态、下次启动再出现。
- FeedbackDialog 用 `src/ui/Dialog`：描述（必填、5000 字计数）、联系方式（可选）、“附带最近日志”勾选（默认勾选）+“预览”打开只读浮层（`logsPreview`）；提交中禁用；成功 toast“已收到，谢谢反馈”；失败保留内容显示错误。
- `main.tsx` 注册 `window.onerror` 与 `unhandledrejection`，节流（同一 message 每分钟 1 次）调用 `reportClientError`。

**约束:**
- 说明文案：“帮助改进 minibot：发送错误类型、崩溃信息、耗时和版本号。不包含对话内容、文件内容和 API Key。”；完整清单列出 Global Constraints 的允许与禁止项。
- 所有文案进 `i18n.ts`；只用语义 token 工具类与 `recipes.ts`。

**验收（手动）:**
- `npm run build --workspace @minibot/renderer` 通过。
- `MINIBOT_HOME` 指向临时目录、`MINIBOT_COLLECT_URL` 指向本地 Task 1 中继：完成初始化 → 勾选默认开启；设置 → 关于 显示版本与开关；提交反馈后用 `node packages/relay/dist/query.js feedback` 能看到；截图初始化页、关于页、反馈对话框（浅色与深色）。
- 不设 `MINIBOT_COLLECT_URL` 启动 → 关于页无开关与反馈按钮，初始化无勾选。
- 把临时 config.json 的 consent 改为 `unset` 重启 → 主界面出现一次提示条。

- [x] **Step 1:** Implement per **思路** and **约束**.
- [x] **Step 2:** Run `npm run build` — expect PASS.
- [x] **Step 3:** 按 **验收（手动）** 启动桌面端检查并截图。
- [x] **Step 4:** Commit.

### Task 6: 桌面主进程：崩溃捕获、收集地址注入与 electron-updater

**Files:**
- Modify: `apps/desktop/src/main.cts`、`apps/desktop/src/preload.cts`、`apps/desktop/package.json`、`apps/desktop/electron-builder.json`、`apps/renderer/src/minibot.d.ts`、`apps/renderer/src/settings/`（关于页更新区）、`apps/renderer/src/main/MainScreen.tsx`（就绪提示条）、`apps/renderer/src/i18n.ts`
- Create: `apps/desktop/src/updater.cts`、`scripts/sync-version.mjs`
- Test: `packages/core/test/electron-runtime.test.ts` 若受依赖变动影响需保持通过

**Interfaces:**
- Consumes: `Kernel.diag`、`Kernel.open({ appVersion, collectUrl })`
- Produces: preload `window.minibot.update: { state(): Promise<UpdateState>; check(): Promise<UpdateState>; install(): Promise<void>; onState(cb: (s: UpdateState) => void): () => void }`
- Produces: `type UpdateState = { phase: 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error'; version?: string; percent?: number; error?: string; checkedAt?: number }`
- Produces: `scripts/sync-version.mjs`：把根 `package.json` 的 `version` 写入 `apps/desktop/package.json`、`apps/mobile/package.json`，并输出安卓 `versionName`/`versionCode` 供 Gradle 读取（Task 9 使用）

**思路:**
- 收集地址：构建时 `apps/desktop` 的 `tsc` 之后由一个小步骤把 `process.env.MINIBOT_COLLECT_URL ?? ''` 写进 `dist/build-info.json`；主进程启动读取，空串当作 `null` 传给 `Kernel.open`。
- 主进程 `process.on('uncaughtException' | 'unhandledRejection')` 与 `app.on('render-process-gone' | 'child-process-gone')` → `kernel.diag.write('error','app',…, crash 事件)`。
- updater.cts：仅 `app.isPackaged` 时启用；`autoUpdater.autoDownload = true`、`autoInstallOnAppQuit = true`；启动 1 分钟后检查，之后每 6 小时；把 electron-updater 事件映射为 `UpdateState` 推送给渲染端；各步写日志与 `update/update.check|download|install` 事件（data：结果、错误类别）。`install()` 在内核有运行中回复时拒绝（渲染端已禁用按钮，主进程再兜底）。
- electron-builder.json 增加 `publish: { provider: 'github', owner: 'JiaMingWang-CN', repo: 'minibot' }`。
- 渲染端：关于页显示版本、“检查更新”按钮与最近结果；`ready` 时主界面顶部提示条“新版本 X.Y.Z 已就绪”+“重启更新”（有运行中回复时禁用并显示“等当前回复结束后再重启”）。
- 未打包运行时 `state()` 返回 `{ phase: 'idle' }`，检查按钮显示“开发版本不检查更新”。

**约束:**
- 检查时机：启动后 60 秒、之后每 6 小时；不强制更新。
- `electron-updater` 锁定精确版本，与 electron-builder 26.18.0 配套（用 Context7 / npm 核对）。
- IPC 处理器沿用 `assertTrusted`。

**验收（手动）:**
- `npm run build` 通过；`npm run pack:dir --workspace @minibot/desktop` 可产出目录版。
- 开发运行：关于页显示“开发版本不检查更新”。
- 在渲染进程控制台 `throw new Error('x')` → 当天日志出现 `crash` 行，堆栈无绝对用户路径。
- 端到端自动更新放在仓库公开后、Task 9 发版时验证（见 Task 9 验收）。

- [x] **Step 1:** Implement per **思路** and **约束**.
- [x] **Step 2:** Run `npm run build` — expect PASS；`npm test` — expect PASS.
- [x] **Step 3:** 按 **验收（手动）** 检查。
- [x] **Step 4:** Commit.

### Task 7: 安卓原生层：日志、事件上传、反馈、崩溃

**Files:**
- Create: `apps/mobile/android/app/src/main/java/app/minibot/mobile/diag/DiagLog.kt`、`.../diag/Scrub.kt`、`.../diag/Uploader.kt`、`.../diag/DiagSettings.kt`
- Modify: `.../RemoteHub.kt`、`.../remote/Connector.kt`、`.../remote/WsCarrier.kt`、`.../MinibotRemotePlugin.kt`、`apps/mobile/android/app/build.gradle`（`buildConfigField COLLECT_URL`）、`apps/mobile/android/app/src/main/AndroidManifest.xml`（确认 INTERNET）
- Test: `apps/mobile/android/app/src/test/java/app/minibot/mobile/diag/DiagLogTest.kt`、`ScrubTest.kt`、`UploaderTest.kt`

**Interfaces:**
- Consumes: Task 1 线协议（`platform: 'android'`）
- Produces: `class DiagLog(dir: File, now: () -> Long)` 带 `write(level, area, msg, fields, event)`、`recent(sinceMs, maxBytes): String`、`events: Flow<DiagEvent>`
- Produces: `object DiagSettings { consent: 'unset'|'on'|'off'; installId: String }`（SharedPreferences）
- Produces: 插件方法 `getDiagnostics(): { consent, available, appVersion }`、`setDiagnostics({ consent })`、`logsPreview(): { text }`、`sendFeedback({ description, contact?, attachLogs })`、`reportClientError({ message, stack? })`

**思路:**
- 与 Task 2/3 同一套规则在 Kotlin 里实现：JSON Lines 按日切文件，7 天 / 20 MB；中继口令、psk 以外从不进日志（Connector 只记阶段与 CloseReason 类型）；`redactLike` 同正则；`scrubStack` 保留 `app.minibot...` 类名与行号。
- 队列存 `files/diag-queue.jsonl`，上限 1000；上传用 OkHttp，gzip，规则同 Task 3（阈值 50/5 分钟、退避 1 分钟→1 小时、400/413 丢批）。
- 插桩：Connector 配对开始/成功/失败原因、局域网/中继选择、断线原因与重连次数、撤销判定（事件 `error/remote.pair`、`error/remote.connect`）；`Thread.setDefaultUncaughtExceptionHandler` 同步写一行 crash 到日志并把事件同步追加到队列文件后交还原 handler；应用启动 `start/app.start`。
- `BuildConfig.COLLECT_URL` 由 Gradle 读环境变量 `MINIBOT_COLLECT_URL`（缺省空串）；空串 → `available = false`。

**约束:**
- 公共字段 `platform: 'android'`、`appVersion = BuildConfig.VERSION_NAME`、`os = "Android " + Build.VERSION.RELEASE`。
- 上传与日志 IO 都在 `Dispatchers.IO`，不得在主线程。
- 原生层不新增任何把私钥、psk、中继口令暴露给网页层的方法。

**验收:**
- `DiagLogTest.retention`：9 天文件 → 留 7 天；超 20 MB（测试上限调小）删最旧。
- `ScrubTest.redact`：`Bearer abcdefghijklmnopqrstuvwxyz0123456789` → `[REDACTED]`；堆栈中 `/data/user/0/app.minibot.mobile/files/x` → `<app>/files/x`。
- `UploaderTest.unset`：consent `unset` 入队 60 条 → MockWebServer 收到 0 个请求。
- `UploaderTest.on`：consent `on` 入队 60 条 → 收到 1 个 gzip 请求，events 60 条，队列清空。
- `UploaderTest.offClears`：切 `off` → 队列文件为空。
- `UploaderTest.feedback`：`attachLogs` true → body 含 `logs` 且 ≤ 1 MB。

- [x] **Step 1:** Write the tests in **验收**; run `npm run test:android --workspace @minibot/mobile` — expect FAIL.
- [x] **Step 2:** Implement per **思路** and **约束**.
- [x] **Step 3:** Run `npm run test:android --workspace @minibot/mobile` — expect PASS.
- [x] **Step 4:** Commit.

### Task 8: 安卓：版本协商、应用内更新与网页层界面

**Files:**
- Create: `apps/mobile/android/app/src/main/java/app/minibot/mobile/update/Updater.kt`、`apps/mobile/android/app/src/main/res/xml/file_paths.xml`、`apps/mobile/src/screens/FeedbackSheet.tsx`、`apps/mobile/src/UpdatePrompt.tsx`
- Modify: `.../remote/Connector.kt`、`.../RemoteHub.kt`、`.../MinibotRemotePlugin.kt`、`AndroidManifest.xml`（`REQUEST_INSTALL_PACKAGES`、`FileProvider`）、`apps/mobile/src/native.ts`、`apps/mobile/src/MobileApp.tsx`、`apps/mobile/src/screens/SettingsSheet.tsx`、`apps/renderer/src/i18n.ts`
- Test: `apps/mobile/android/app/src/test/java/app/minibot/mobile/update/UpdaterTest.kt`、`.../remote/ConnectorTest.kt`（补用例）

**Interfaces:**
- Consumes: Task 4 的 `version` 消息，Task 7 的插件方法
- Produces: 插件方法 `checkUpdate({ manual: boolean }): { available: boolean; version?: string; notes?: string }`、`downloadAndInstall(): void`；事件 `updateProgress { percent }`、`updateError { message }`
- Produces: `PhoneStatus.compat: 'ok' | 'phone_outdated' | 'pc_outdated' | 'unknown'`
- Produces: `fun versionCodeOf(tag: String): Int?`（`v1.2.3` → `10203`）

**思路:**
- Connector：收到 `ready` 后发送 `version`（`protocol 1`、`minPeer 1`、`app = VERSION_NAME`）；收到电脑 `version` 后按 Task 4 同一规则判定，写入 `PhoneStatus.compat`；电脑不发 version → `unknown` 照常。
- Updater：GET `https://api.github.com/repos/JiaMingWang-CN/minibot/releases/latest`（带 `Accept: application/vnd.github+json`）；比较 `versionCodeOf(tag_name)` 与 `BuildConfig.VERSION_CODE`；资产取名为 `minibot-X.Y.Z.apk` 与 `.apk.sha256`；自动检查每天最多一次（时间戳存 SharedPreferences），手动检查不受限。
- 下载到 `cacheDir/update/`，写 `.part` 后校验大小（资产 `size`）与 SHA-256，通过再改名；`FileProvider` + `ACTION_VIEW` 调起安装；`canRequestPackageInstalls()` 为 false 时打开 `ACTION_MANAGE_UNKNOWN_APP_SOURCES`。失败删除半成品。各步写日志与 `update/*` 事件。
- 网页层：启动后 `checkUpdate({ manual:false })`，有新版弹 `UpdatePrompt`（版本、更新说明、“更新”/“稍后”，下载进度）；设置页加：版本、“检查更新”、“发送诊断信息”开关、“反馈问题”（`FeedbackSheet`，规则同 Task 5）；首次打开且 consent `unset` 时显示同 Task 5 的说明提示；`compat` 不兼容时连接页显示 Task 4 的文案（`phone_outdated` 附“检查更新”按钮）；`window.onerror`/`unhandledrejection` 节流调用 `reportClientError`。

**约束:**
- 文案与 Task 4/5 共用 i18n 键；新增更新相关键（“发现新版本 {version}”“更新”“稍后”“正在下载 {percent}%”“下载失败，请稍后重试”“请允许 minibot 安装应用”）。
- 不比较字符串版本，只比较 `versionCode`；`tag_name` 不合 `vX.Y.Z` 视为无更新。

**验收:**
- `UpdaterTest.newer`：MockWebServer 返回 `v0.2.0`，本机 `VERSION_CODE` 100 → `available` true。
- `UpdaterTest.sameOrOlder`：`v0.1.0` 或 `nightly` → false。
- `UpdaterTest.hashMismatch`：sha256 文件与内容不符 → 抛错，`cacheDir/update/` 无 apk 残留。
- `UpdaterTest.dailyLimit`：自动检查当天第二次 → 不发请求；`manual: true` → 发请求。
- `ConnectorTest.sendsVersion`：握手后收到 `ready` → 手机发出 `t:'version'`、`protocol:1`。
- `ConnectorTest.phoneOutdated`：电脑 `version` 带 `minPeer: 2`（电脑要求更新的手机协议）→ 状态 `compat: 'phone_outdated'`；`ConnectorTest.pcOutdated`：电脑报 `protocol: 0`（低于手机要求的最低电脑协议）→ `compat: 'pc_outdated'`。
- 手动：`npm run build --workspace @minibot/mobile` 通过；装到手机/模拟器，设置页显示版本、开关、反馈，提交反馈后 `query feedback` 可见。

- [x] **Step 1:** Write the tests in **验收**; run `npm run test:android --workspace @minibot/mobile` — expect FAIL.
- [x] **Step 2:** Implement per **思路** and **约束**.
- [x] **Step 3:** Run `npm run test:android --workspace @minibot/mobile` 与 `npm run build --workspace @minibot/mobile` — expect PASS；做手动检查。
- [x] **Step 4:** Commit.

### Task 9: 统一版本号与发布流水线

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `apps/mobile/android/app/build.gradle`（`versionName`/`versionCode` 来自根版本）、`apps/desktop/package.json`（`pack` 脚本加 `--publish never` 供本地）、根 `README` 或 `docs/` 的发布说明一节

**Interfaces:**
- Consumes: `scripts/sync-version.mjs`（Task 6）、Secrets `MINIBOT_KEYSTORE_BASE64`、`MINIBOT_KEYSTORE_PASSWORD`、`MINIBOT_KEY_ALIAS`、`MINIBOT_KEY_PASSWORD`、仓库 Variable `MINIBOT_COLLECT_URL`

**思路:**
- build.gradle 读取根 `package.json` 的 `version` 计算 `versionName` 与 `versionCode`（公式见 Global Constraints）。
- `release.yml` 触发 `push: tags: ['v*']`；第一步校验标签去掉可选 `-rc.N` 后缀后 == `v${根 version}`，不符直接失败；带 `-rc` 的标签发布为 prerelease（GitHub `releases/latest` 与 electron-updater 默认都忽略 prerelease，正式用户不会收到）。根版本号不在本任务里改。
  - `windows-latest`：Node 24、`npm ci`、`node scripts/sync-version.mjs`、`npm run build`（带 `MINIBOT_COLLECT_URL`）、`electron-builder --win nsis --x64 --publish always`（`GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`），产出 `minibot-setup-X.Y.Z.exe`、`.blockmap`、`latest.yml` 上传到同名 Release（草稿 → 两作业都成功后发布）。
  - `ubuntu-latest`：Node 24、JDK（与 Gradle 9.1.0 匹配的版本）、Android SDK；从 Secret 解码 keystore 到 `$RUNNER_TEMP`；`npm run apk --workspace @minibot/mobile`；重命名为 `minibot-X.Y.Z.apk`，生成 `minibot-X.Y.Z.apk.sha256`（只含十六进制摘要）；`gh release upload`。
  - 最后一个作业把草稿 Release 发布，正文取标签注释（`git tag -a` 的消息）。
- 文档写明：发版步骤（改根版本 → 提交 → `git tag -a vX.Y.Z -m "更新说明"` → push 标签）、需要的 Secrets/Variables、签名密钥不能更换。

**约束:**
- Release 必须同时包含：`minibot-setup-X.Y.Z.exe`、`minibot-setup-X.Y.Z.exe.blockmap`、`latest.yml`、`minibot-X.Y.Z.apk`、`minibot-X.Y.Z.apk.sha256`。
- 两个作业任一失败则 Release 保持草稿（不被客户端看到）。
- keystore 文件只写在 `$RUNNER_TEMP`，作业结束不上传为 artifact。

**验收:**
- 本地 `node scripts/sync-version.mjs` 后 `apps/desktop/package.json` 与 `apps/mobile/package.json` 版本等于根版本；Gradle 打印 `versionCode` 为 `100`（0.1.0）。
- 推一个测试标签 `v0.1.0-rc.1` → Actions 两作业成功，草稿/预发布 Release 含上述 5 个文件；下载的 APK 用 `apksigner verify --print-certs` 指纹为 `EA:3C:CB:…:A3:5E`。
- 仓库公开后：装 0.1.x 正式版桌面端 → 发 0.1.(x+1) → 1 分钟后出现“已就绪”提示，重启后版本更新；装旧 APK → 应用内更新到新版且数据保留。

- [x] **Step 1:** Implement per **思路** and **约束**.
- [x] **Step 2:** 本地验证 sync-version 与 Gradle 版本号。
- [x] **Step 3:** 推测试标签验证流水线；仓库公开后做端到端更新验证。
- [x] **Step 4:** Commit.
