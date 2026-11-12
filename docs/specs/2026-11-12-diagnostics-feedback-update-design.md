# minibot 诊断数据、反馈与应用内更新 设计文档

日期：2026-11-12　状态：已批准
关系：扩展 `2026-11-07-minibot-core-design.md` 与 `2026-11-11-android-remote-design.md`。安卓设计里"自用 APK、不上架"的定位在本文改为"**分发给其他人使用**"；其余原则（中继看不到对话、不依赖第三方云服务）保持不变。

## 1. 意图与动机

minibot（桌面端 + 安卓端）要分发给其他人安装。分发之后，作者看不到别人那里发生了什么：模型请求失败、工具执行出错、配对 / 连接失败、崩溃，都只能等用户描述。需要：

1. **诊断数据**：两端自动把结构化的运行状况和失败信息送回作者的服务器，用来观察运行状况、找出失败原因。
2. **反馈**：用户能在应用里提交问题描述，可选附带最近的完整日志。
3. **发布与应用内更新**：安装包发布到 GitHub Releases，两端在应用内检查并安装新版本。

## 2. 目标 / 非目标 / 反目标

**目标**
- 两端在本机写滚动日志，作为诊断与反馈附件的唯一来源。
- 诊断事件（结构化、脱敏）自动上传到作者服务器上的中继进程，存进 SQLite，作者用命令行查询。
- 电脑端、手机端都有"反馈问题"入口；可勾选附带最近日志，提交前可预览。
- 用户可在初始化流程和设置里关闭诊断上传；反馈不受此开关限制。
- 推送 `vX.Y.Z` 标签后由 GitHub Actions 构建 Windows 安装包和 APK，发到同一个 Release。
- 电脑端用 electron-updater 后台下载、提示重启更新；手机端检查 Release、下载 APK、校验后调起系统安装。

**非目标**
- 网页看板、告警、图表（作者用 SQL / 脚本查）。
- 回复反馈、工单系统（反馈带可选联系方式，作者自行联系）。
- 强制更新、灰度发布、增量更新、多渠道（beta）。
- Windows 代码签名证书、安卓上架。
- 自建下载镜像（先观察 GitHub 访问情况，见 §6.4）。
- iOS、macOS、Linux 桌面安装包。

**反目标（即使能跑也算失败）**
- 任何上传内容含对话内容、bot 人设、记忆、API Key、中继口令、配对密钥。反馈附带的完整日志同样不得含这些——**日志本身就不写它们**。
- 自动上传的事件里出现未脱敏的命令原文、文件路径、用户名、模型报错原文。
- 关闭诊断开关后仍有任何自动上传。
- 中继的转发路径受影响：收集功能出错、磁盘满、被刷，不能让 WebSocket 转发变慢或断开。
- 别人按 README 自建中继时，默认就开始落盘收集数据。
- 一把新的安卓签名密钥（会导致无法覆盖安装）；签名材料进入仓库。
- 仓库改为公开时历史里带着密钥。

## 3. 约束（来自现有代码）

- 中继 `packages/relay`：Node 24，`ws`，`startRelay` 里 `new WebSocketServer({ host, port, path: '/v1' })` 自建监听；README 承诺"不落盘，不打印负载"。部署在作者服务器，前面是 Caddy（`Caddyfile.example`）。
- 内核 `packages/core`：已用 `node:sqlite` 的 `DatabaseSync`；数据根目录 `MINIBOT_HOME`（默认见 `apps/desktop/src/main.cts` 的 `defaultDataRoot()`）。渲染端经内核本机接口（`packages/core/src/server`）通信。
- 桌面端 `apps/desktop`：Electron 45、electron-builder 26，NSIS x64，`artifactName: minibot-setup-${version}.${ext}`，当前版本 0.1.0。
- 渲染端 `apps/renderer`：遵守 `.claude/CLAUDE.md` 的设计规范（语义 token、`src/ui/` 浮层、文案集中在 `src/i18n.ts`）。
- 安卓端 `apps/mobile`：Capacitor 网页界面 + Kotlin 原生插件 `MinibotRemotePlugin` / `RemoteHub`；`versionCode 1 / versionName "1.0"`；release 签名只从环境变量 `MINIBOT_KEYSTORE*` 读取。
- 仓库 `JiaMingWang-CN/minibot` 目前私有，作者决定改为公开；现有 `.github/workflows/ci.yml`（ubuntu，lint/build/test）。

## 4. 方案（已选定）

考虑过三种收集点实现：

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| A 独立收集服务 | 新建 `packages/collector`，与中继同机、Caddy 转发 | 与中继解耦；多部署一个进程 |
| **B 并入中继（选定）** | 中继进程新增 HTTP 收集接口，写 SQLite | 只部署一个进程；中继不再"纯转发" |
| C GlitchTip + Sentry SDK | 自建 Sentry 兼容平台 | 功能最强；要 Postgres/Redis，维护重，且作者选了命令行查看 |

作者选 **B**。为不违背"别人自建中继默认不落盘"的反目标，收集功能**默认关闭**，只在设置 `RELAY_COLLECT_DB` 时开启（§5.1）。（这一条是设计方的决定。）

发布与更新只有一种合理做法：公开仓库的 GitHub Releases + electron-updater（桌面）+ 应用自查 Release（安卓）。另两条路——单独的公开发布仓库、或只用自己服务器分发——作者已放弃。

## 5. 设计

### 5.1 中继：收集接口

- 新增环境变量：
  - `RELAY_COLLECT_DB`：SQLite 文件路径。不设 = 不开启收集，HTTP 收集路径一律 404，行为与现在完全一致。
  - `RELAY_COLLECT_MAX_MB`（默认 2048）：数据库达到上限后拒收新数据（返回 507），不删旧数据。
- 中继改为自建 `http.Server`，`WebSocketServer` 挂在它的 upgrade 上，`/v1` 的 WebSocket 行为不变。新增：
  - `POST /collect/v1/events`：body 为 JSON（可 gzip），一批事件，≤ 256 KB（解压后 ≤ 1 MB），≤ 200 条。
  - `POST /collect/v1/feedback`：body 为 JSON（可 gzip），≤ 2 MB（解压后 ≤ 8 MB）；含描述、可选联系方式、可选日志附件文本。
  - 成功 `204`；格式错 `400`；超限 `413`；限流 `429`；未开启 `404`；存储满 `507`。
- 无口令，匿名上传。防滥用：按 IP（沿用 `RELAY_TRUST_PROXY` 的真实地址逻辑）每分钟 events 30 次、feedback 3 次；单个 `installId` 每天 feedback 20 条。
- 写库与 WebSocket 转发隔离：收集请求处理失败只影响该请求；写库用同步 `DatabaseSync` 但单条批次小，若出现异常记一行日志后返回 500，不抛到转发逻辑。
- 中继自身日志仍不打印收集到的内容，只打印计数和错误。
- 表结构（`schemaVersion` 1）：
  - `events(id, received_at, install_id, platform, app_version, os, kind, name, data_json)`
  - `feedback(id, received_at, install_id, platform, app_version, os, description, contact, logs)`
  - `kind`/`name` 见 §5.3；`data_json` 原样保存客户端结构化字段。
- 附带命令行脚本 `packages/relay/src/query.ts`（构建后 `node dist/query.js`），提供常用汇总：按版本 / 名称统计最近 N 天事件、列出最近反馈、查看某条反馈全文、导出某 installId 的事件。复杂查询直接 `sqlite3`。
- README 增加"诊断收集（可选）"一节，明确：不设 `RELAY_COLLECT_DB` 时中继仍不落盘；设了之后会存哪些数据。`Caddyfile.example` 无需改动（同一端口）。

### 5.2 客户端：本地日志

- **电脑端**（内核内实现，桌面主进程与内核共用）：`MINIBOT_HOME/logs/minibot-YYYY-MM-DD.log`，JSON Lines，保留 7 天、总量 ≤ 50 MB，超出删最旧。
- **手机端**（Kotlin 原生实现，网页层通过插件方法写入）：应用私有目录 `files/logs/`，同样 JSON Lines，保留 7 天、≤ 20 MB。
- 每行：`ts, level(info|warn|error), area, msg, ...fields`。
- **写什么**：
  - 模型请求：服务 presetId/格式、模型 id、耗时、token 数、成功 / 失败、HTTP 状态、错误报文（完整日志里可保留错误报文原文，但需经 §5.4 的密钥过滤）。
  - 工具调用：工具名、退出码、耗时、是否被拒绝 / 超时；`run_command` 的命令原文、文件路径在**完整日志**里保留。
  - 远程连接：配对开始 / 成功 / 失败原因、局域网 / 中继选择、断线原因与重连次数、撤销判定。
  - 未捕获异常（Electron 主进程、渲染进程 `error`/`unhandledrejection`、内核、安卓 `Thread.setDefaultUncaughtExceptionHandler`、网页层）。
  - 更新检查 / 下载 / 安装各步结果。
  - 应用启动（版本、系统）、退出。
- **绝不写**：消息正文、bot 人设、记忆内容、API Key、中继口令、配对 psk / 私钥、图片内容。

### 5.3 诊断事件（自动上传）

- 从日志写入点同步产生结构化事件（不是事后解析日志文件）：日志 API 在写入时若该条标记为事件，则按白名单字段生成事件放入上传队列。
- 事件 `kind`：`start`（启动）、`error`（失败）、`crash`（未捕获异常）、`metric`（耗时等，聚合后上报，见下）、`update`（更新各步结果）。`name` 为稳定的点分名，如 `model.request`、`tool.run_command`、`remote.pair`、`remote.connect`、`update.check`。
- **只允许的字段**：枚举值、数字、布尔、错误类型 / 错误码（如 HTTP 状态、`ECONNRESET`、`CloseReason` 类型）、经 §5.4 脱敏的异常堆栈、模型 id、服务 presetId（自定义服务只报格式不报 baseUrl）。不允许任何自由文本字段。
- `metric`：每小时在本地聚合一次（如模型请求次数 / 失败数 / p50 / p95 耗时，按 presetId+模型分组）后作为一条事件上报，避免逐条上传。
- 公共字段：`installId`（首次启动生成的随机 UUID，存本地，与身份无关；电脑与手机各自独立）、`platform`（`win32`/`android`）、`appVersion`、`os`（系统版本）。
- 上传：本地队列（电脑存内核 SQLite，手机存私有目录文件），每 5 分钟或积满 50 条批量 gzip 上传；失败指数退避；队列上限 1000 条，超出丢最旧。诊断开关关闭时立即清空队列且不再入队。
- 手机端直接 HTTPS 上传到收集点，不经电脑转发（配对 / 连接失败时恰恰需要它）。
- 收集点地址：**源码里没有默认值**。只在构建时由环境变量 `MINIBOT_COLLECT_URL` 写入（桌面构建与安卓构建各自读取）；`release.yml` 从仓库 Variables 注入作者服务器地址（形如 `https://<中继域名>/collect`，与中继同一个 Caddy 站点）。为空则上传与反馈功能整体关闭——本地开发、测试构建、他人自行构建都不会向作者上传。（设计方决定）
- 同意状态有三值：`unset` / `on` / `off`，存本地（电脑存内核配置，手机存私有目录）。`unset` 时事件只入本地队列、不上传；初始化流程或首屏提示让用户表态后才按结果上传或清空。从 0.1.0 升级上来、不再走初始化流程的老用户，在主界面显示一次同样的提示。（设计方决定）

### 5.4 脱敏

两层，都在客户端做：

1. **密钥过滤（日志写入时，对所有内容）**：剔除匹配常见 API Key 形态（`sk-…`、`Bearer …`、长随机串）、配置中的已知密钥值（运行时把当前 API Key、中继口令加入过滤表）的子串，替换为 `[REDACTED]`。
2. **路径 / 身份脱敏（生成事件、堆栈时）**：用户主目录 → `~`，工作区根 → `<workspace>`，Windows 用户名、主机名 → `<user>` / `<host>`；堆栈只保留函数名与相对源码位置。

反馈附件用的是日志的近期片段（`DiagLog.recent()`），已过第 1 层，并在 `recent()` 输出时再过第 2 层路径 / 身份脱敏（本地日志文件本身保留完整路径）。提交前的预览与实际上传使用同一份 `recent()` 输出，可预览全文。

### 5.5 开关

- 初始化流程（`apps/renderer/src/onboarding`）末尾加一项"发送诊断信息"，**默认开启**，下附一句说明会发什么、不发什么，并可展开查看完整清单。
- 电脑端设置页、手机端设置加同名开关。电脑端开关只管电脑端；手机端开关只管手机端（手机初次打开时以首屏提示的方式给出同样说明和开关）。
- 关闭后：不入队、清空队列、不上传。反馈仍可用。

### 5.6 反馈

- 入口：电脑端设置页"反馈问题"；手机端设置页"反馈问题"。
- 表单：问题描述（必填，≤ 5000 字）、联系方式（可选，≤ 200 字）、"附带最近日志"勾选框（默认勾选）+"预览"按钮（打开只读浮层显示将附带的内容）。
- 附带内容：最近 24 小时日志，截断到 1 MB（保留最新部分）。
- 提交成功提示"已收到"；失败提示原因并保留表单内容可重试；无收集点地址时入口隐藏。

### 5.7 发布

- 版本号：电脑端、手机端统一，单一来源为根 `package.json` 的 `version`；构建时同步到 `apps/desktop/package.json` 与安卓 `versionName`；`versionCode = major*10000 + minor*100 + patch`。
- 新增 `.github/workflows/release.yml`，触发：推送 `v*` 标签。
  - Windows 作业：`npm ci && npm run build`，electron-builder 打 NSIS，`publish: github` 上传 `minibot-setup-X.Y.Z.exe`、`.blockmap`、`latest.yml`。
  - Linux 作业：构建网页层与 APK（JDK 与现有 Gradle 9.1.0 匹配），签名密钥从 Secrets 还原（`MINIBOT_KEYSTORE_BASE64` 解码为文件，另三项直接作环境变量），产出 `minibot-X.Y.Z.apk` 与 `minibot-X.Y.Z.apk.sha256`。
  - `MINIBOT_COLLECT_URL` 来自仓库 Secrets / Variables 注入两边构建。
  - Release 正文取标签注释或 `CHANGELOG` 对应段落（构建者择一）。
- 公开仓库前的检查（作者手动改公开，本工作只提供检查结果）：用 gitleaks（或同类）扫描完整历史，确认无 API Key、中继口令、keystore 文件、签名口令；有则先清理历史或轮换密钥（这一步作者决定，不在本工作内）。
- 顺序（设计方决定）：代码与 `release.yml` 可在私有仓库里完成并用标签试跑构建；**更新链路的端到端验收在仓库公开之后**做（electron-updater 与手机端匿名请求都依赖公开仓库），不为私有阶段做带 token 的方案。

### 5.8 电脑端应用内更新

- 依赖 `electron-updater`，`provider: github`，指向 `JiaMingWang-CN/minibot`。
- 时机：启动后 1 分钟检查一次，之后每 6 小时检查；`autoDownload: true`，`autoInstallOnAppQuit: true`。
- 下载完成后渲染端显示一个不打扰的提示条"新版本 X.Y.Z 已就绪"+"重启更新"按钮；有回复进行中时按钮禁用并说明原因。不强制。
- 设置页显示当前版本、"检查更新"按钮和最近检查结果。
- 开发运行（未打包）时不检查。各步结果写日志并产生 `update.*` 事件。

### 5.9 手机端应用内更新

- 启动时（每天最多一次）请求 `https://api.github.com/repos/JiaMingWang-CN/minibot/releases/latest`，取 `tag_name`、正文与 `.apk` / `.apk.sha256` 资产。
- 版本更高时弹窗：版本号、更新说明、"更新" / "稍后"。设置页也有"检查更新"。
- "更新"：在原生层下载 APK 到应用缓存目录（显示进度），校验大小与 SHA-256，通过 `FileProvider` + `ACTION_VIEW`（`application/vnd.android.package-archive`）调起系统安装。需 `REQUEST_INSTALL_PACKAGES` 权限；未授权时引导到系统"安装未知应用"设置页。
- 签名密钥始终使用现有那一把（`MINIBOT_KEYSTORE`）；不一致系统会拒绝覆盖安装——这是发布流程的约束，不在应用里处理。已核实（2026-11-12）：本机 `app-release.apk` 的证书指纹与 `~/.minibot-signing/release.jks` 一致（SHA-256 `EA:3C:CB:…:A3:5E`），四项签名 Secrets（`MINIBOT_KEYSTORE_BASE64`、`MINIBOT_KEYSTORE_PASSWORD`、`MINIBOT_KEY_ALIAS`、`MINIBOT_KEY_PASSWORD`）已放进仓库。若有人装的是 debug 签名包（`CN=Android Debug`），只能卸载重装一次。
- `versionCode` 新规则下 0.1.0 = 100，大于现有的 1，可平滑覆盖。

### 5.10 两端版本协商

两端会独立更新，版本不一致是常态。现有协议除 Noise 前缀 `minibot-remote/1` 外没有版本信息。

- 加密通道握手成功后，双方第一条消息互发 `{type:'version', app:'X.Y.Z', protocol:N}`（`protocol` 从 1 开始，消息格式有不兼容改动时 +1）。电脑端同时声明自己能接受的最低手机协议版本，反之亦然。
- 不兼容时连接保持但不进入正常收发：手机端显示"电脑端版本过旧，请在电脑上更新 minibot"或"手机端版本过旧，请更新"（后者附"检查更新"按钮）；电脑端在"设置 → 手机"的设备列表里显示同样状态。
- 对端不发 `version`（0.1.0 旧版）视为 `protocol 1`，照常工作。
- 版本不兼容记日志并产生 `remote.version_mismatch` 事件。
- 各步结果写日志并产生 `update.*` 事件（便于观察 GitHub 在国内的可达性）。

## 6. 留给实现者

1. 日志 / 事件 API 的具体形态（函数签名、area 命名表），只要满足 §5.2–5.4 的边界。
2. 中继内 HTTP 与 WebSocket 共存的具体写法，只要现有中继测试不改也全部通过。
3. 密钥过滤的正则细节与测试样例。
4. 手机网页层与原生层之间日志、反馈、更新的插件方法划分。
5. 渲染端提示条、反馈表单的具体视觉，遵守 `.claude/CLAUDE.md` 设计规范，文案进 `i18n.ts`。
6. Release 正文来源（标签注释或 CHANGELOG）。
7. 若之后发现 GitHub 在国内下载普遍失败（看 `update.*` 事件），再设计镜像——不在本次范围。

## 7. 验收

- 中继：不设 `RELAY_COLLECT_DB` 时 `/collect/*` 返回 404 且不创建任何文件；设置后能收、限流、超限返回正确状态码；现有中继测试全部通过；收集路径出错不影响 WebSocket 转发（有测试）。
- 脱敏：单元测试覆盖 API Key、口令、主目录路径、用户名在事件与日志中被替换；事件里不出现非白名单字段。
- 开关：关闭后网络层零上传（测试或抓包）。
- 反馈：两端提交后能用 query 脚本看到描述与附件。
- 版本协商：新旧版组合（新电脑 + 0.1.0 手机、协议号不兼容的模拟）分别得到正常工作或明确提示。
- 发布：推送测试标签生成含 exe、blockmap、latest.yml、apk、sha256 的 Release；旧版本桌面端能自动更新到新版本；旧版本 APK 能在应用内升级到新版本。
