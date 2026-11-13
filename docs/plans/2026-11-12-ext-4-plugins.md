# 扩展第 4 期：插件、市场与搜索插件 实现计划

> **For agentic workers:** Implement this plan task-by-task, in order. Each task's requirements include the Global Constraints below; each task's Interfaces block tells you the names and types neighboring tasks use. The plan gives approach and constraints only — you write the tests and the code. Steps use checkbox (`- [ ]`) syntax for tracking — tick each one as it is done.

**Goal:** minibot 自有插件格式；三种安装方式（文件夹或 zip、Git、市场）和检查更新、卸载；预装 DeepSeek（自封装 MCP）和 Tavily（官方 MCP）两个搜索插件，在插件页连接，在设置里切换搜索引擎。

**Architecture:** `packages/core/src/plugins/` 负责清单解析、变量替换、安装流水线（来源 → 临时目录 → 校验 → 确认 → 落盘）、更新与卸载。插件里的 MCP server 转成第 3 期的 `McpServerConfig`（`origin.kind = 'plugin'`），由 `McpManager` 统一管理。预装插件放在应用资源目录，由内核按路径加载。搜索插件的工具由 `SearchToolProvider` 以 `web` 来源注册，`McpToolProvider` 跳过它们。

**Tech Stack:** Node 24、系统 `git`、zip 解压库（Task 3 选型）、第 3 期的 `@modelcontextprotocol/client`、electron-builder 26（`extraResources`）。

**Spec:** `docs/specs/2026-11-12-extensions-design.md` §5.4（另见 §2 反目标、§5.7、§6）。依赖第 1–3 期计划已完成。

## Global Constraints

- 插件清单文件名 `minibot-plugin.json`；`name` 规则：1–64 位小写字母、数字、连字符，不以连字符开头或结尾，不含 `--`。
- 变量替换只在 MCP 配置的 `command`、`args`、`env`、`url`、`headers` 里进行，只认 `${config.KEY}` 和 `${PLUGIN_ROOT}`，不经过 shell。
- 第三方插件安装前必须显示确认页，列出每个 stdio server 的完整命令行；用户确认前不启动任何东西。
- Git 只支持 `https://` 地址；用系统 `git`，没装时提示 `需要先安装 Git`。
- zip：拒绝路径逃逸条目（绝对路径、含 `..`、符号链接），解压后总大小上限 100 MB、条目数上限 5000。
- 默认市场源列表为空（`DEFAULT_MARKETS = []`）。
- 预装插件（`deepseek`、`tavily`）：不能删除、可以停用、不走检查更新、不显示安装确认页。
- DeepSeek / Tavily 的原生能力不改：工具名、参数、返回按官方原样。
- 搜索插件的工具只在“已连接 + 被选为搜索引擎 + bot 开了联网”时出现，按 `web` 类别审批。
- 敏感配置存 `secrets.bin`，键名 `plugin:<name>:config:<KEY>`。
- 界面文案进 `apps/renderer/src/i18n.ts`；视觉遵守 `.claude/CLAUDE.md`。新依赖锁定精确版本，使用前用 Context7 或探针核实。
- 测试：`node --test "packages/core/test/*.test.ts"`；`npm run build --workspace @minibot/core`；`npm run build --workspace @minibot/renderer`；`npm run build --workspace @minibot/desktop`；`npm run lint`。

## Review Focus

- 安装中途失败（克隆失败、校验失败、用户取消）→ 临时目录被删除，已装插件和配置不受影响（Task 3）。
- 更新失败（新版本校验不过）→ 旧版本原样保留并继续工作（Task 4）。
- 插件名和已有插件或单独添加的 MCP server 冲突 → 拒绝并说明，不覆盖（Task 3）。
- 被选为搜索引擎的插件后来被停用、断开或 Key 失效 → 搜索工具消失或返回官方错误，设置页提示该引擎不可用，不影响 `web_fetch`（Task 6）。
- DeepSeek 插件复用的服务后来被删除或换了 Key → 下次连接时用新 Key 或提示重新选择，不用旧 Key（Task 5）。

---

### Task 1: 插件清单与变量替换

**Files:**
- Create: `packages/core/src/plugins/manifest.ts`
- Test: `packages/core/test/plugin-manifest.test.ts`、`packages/core/test/fixtures/plugins/`

**Interfaces:**
- Consumes: `McpServerDraft`、`parseMcpJson`（第 3 期）
- Produces:
  - `interface PluginConfigField { key: string; title: string; description: string; secret: boolean; required: boolean }`
  - `interface PluginManifest { name: string; version: string; description: string; author?: string; homepage?: string; config: PluginConfigField[] }`
  - `interface PluginBundle { manifest: PluginManifest; root: string; mcp: McpServerDraft[]; skillDirs: string[]; problems: string[] }`
  - `readPluginBundle(dir: string): Promise<PluginBundle>`（不合规时抛 `PluginError`，带全部原因）
  - `resolvePluginServers(bundle: PluginBundle, values: Record<string, string>): McpServerDraft[]`（做变量替换）

**思路:**
- 清单校验：必填 `name`、`version`、`description`；`config[].key` 匹配 `^[A-Za-z_][A-Za-z0-9_]*$` 且不重复。
- `mcp.json` 用第 3 期的 `parseMcpJson`；`ignored` 里有内容时写进 `problems`（作为提示，不阻止安装）。
- `skills/` 下每个子目录记进 `skillDirs`，本期只检查子目录里有 `SKILL.md`，缺失写进 `problems`；skill 的格式校验和加载在第 5 期。
- 变量替换：`${config.KEY}` 引用了清单没声明的键 → 校验失败 `mcp.json 引用了未声明的配置：KEY`；`${PLUGIN_ROOT}` 替换为插件安装目录的绝对路径。替换后的值不再被解析第二次。

**约束:**
- 错误文案前缀统一 `插件格式错误：`。

**验收:**
- `合规插件`：fixtures `ok-plugin`（清单 + 一个 stdio server + 一个 skill 目录）→ 解析成功，`mcp` 一个、`skillDirs` 一个。
- `缺清单`：→ `插件格式错误：缺少 minibot-plugin.json`。
- `非法名`：`name: "My--Plugin"` → 失败并说明名字规则。
- `未声明配置`：`args` 含 `${config.TOKEN}`、清单没有 `TOKEN` → 失败，文案如上。
- `替换`：`args: ["${PLUGIN_ROOT}/server.js", "--key=${config.K}"]`，`K` 为 `abc` → 替换为 `<root>/server.js` 和 `--key=abc`。
- `不二次替换`：配置值本身是字符串 `${PLUGIN_ROOT}` → 替换后保持字面。

- [ ] **Step 1:** 写测试与 fixtures；运行 `node --test packages/core/test/plugin-manifest.test.ts`，预期 FAIL。
- [ ] **Step 2:** 实现。
- [ ] **Step 3:** 测试 PASS。
- [ ] **Step 4:** 提交。

### Task 2: 已装插件登记、连接与卸载

**Files:**
- Create: `packages/core/src/plugins/registry.ts`
- Modify: `packages/core/src/extensions/store.ts`、`packages/core/src/mcp/config.ts`、`packages/core/src/kernel.ts`、`packages/core/src/paths.ts`
- Test: `packages/core/test/plugin-registry.test.ts`

**Interfaces:**
- Consumes: Task 1；`McpManager`、`McpServerConfig.origin`（第 3 期）；`enableForMainBot` / `removeFromAllBots`（第 1 期）
- Produces:
  - `interface InstalledPlugin { name: string; version: string; builtin: boolean; source: { kind: 'local' } | { kind: 'git'; url: string; ref: string | null; commit: string } | { kind: 'market'; marketUrl: string; url: string; ref: string | null; path: string | null; commit: string } | { kind: 'builtin' }; enabled: boolean; serverIds: string[] }`
  - `ExtensionsFile` 新增 `plugins: InstalledPlugin[]`、`markets: string[]`
  - `DataPaths.pluginsDir`（`<root>/plugins`）
  - `type PluginStatus = 'not_connected' | 'connected' | 'error'`
  - `PluginService.list(): Promise<(InstalledPlugin & { manifest: PluginManifest; status: PluginStatus; problems: string[] })[]>`
  - `PluginService.connect(name: string, values: Record<string, string>): Promise<void>`
  - `PluginService.setEnabled(name: string, enabled: boolean): Promise<void>`
  - `PluginService.uninstall(name: string): Promise<void>`
  - `OpenOptions.builtinPluginsDir?: string`
  - `Bot` 新增 `pluginExclusions: string[]`（该 bot 在已启用插件里单独关掉的 MCP server id 或 skill id；`migrate` 缺失时补 `[]`，非字符串剔除）
  - `Kernel.updateBot` 的 patch 接受 `pluginExclusions`

**思路:**
- 插件里的每个 MCP server 生成一个 `McpServerConfig`，`origin: { kind: 'plugin', pluginId: name }`，`cwd` 默认插件目录；这些 server 不出现在第 3 期“MCP”栏的可编辑列表里（只读显示归属）。
- 状态：必填配置没填全 → `not_connected`（不启动它的 server）；全部 server 已连接 → `connected`；否则 `error`。
- `connect`：校验必填项 → 敏感值存密钥库、普通值存 `extensions.json`（插件条目下的 `config` 对象）→ 用 `resolvePluginServers` 生成 server 配置 → 启动。没有密钥库且有敏感字段时拒绝，文案 `当前系统没有可用的密钥库，无法保存这个插件的密钥`。
- 第三方插件装好后 `enableForMainBot('plugins', name)`；bot 的 `extensions.plugins` 含插件名时，其 server 中不在 `pluginExclusions` 里的那些，视同在 `extensions.mcpServers` 里（`McpToolProvider` 和 `McpManager.start` 都按这个合并后的集合判断）。卸载时同时从所有 bot 的 `pluginExclusions` 里删除该插件的条目。
- `setEnabled(false)`：全局停用，断开它的 server，不删配置。
- `uninstall`：预装插件拒绝（`预装插件不能删除`）；否则断开 → 删除 `plugins/<name>/` → 删除 `plugin:<name>:` 开头的密钥 → `removeFromAllBots('plugins', name)` → 删登记。
- 内核启动时扫描 `builtinPluginsDir`，把其中的插件登记为 `builtin: true`（已登记则保留用户的配置与启用状态，版本号按资源目录里的更新）。

**约束:**
- 插件名与已登记插件重名 → 拒绝 `已安装同名插件：<name>`。

**验收:**
- `未连接不启动`：装好、未填必填配置 → 状态 `not_connected`，`McpManager` 中无其 server 连接。
- `连接后启动`：填配置 → server 连接，状态 `connected`；secret 值不在 `extensions.json` 里。
- `bot 启用插件即启用其 server`：主 bot `extensions.plugins` 含插件 → 快照含其工具；另一个 bot 不含。
- `单独关掉插件里的 server`：插件有两个 server，主 bot 的 `pluginExclusions` 含其中一个的 id → 快照只含另一个的工具。
- `停用`：`setEnabled(false)` → server 断开，工具从下一轮快照消失；再启用恢复。
- `卸载清理`：卸载后目录、密钥、bot 引用、登记都不存在。
- `预装不可删`：`uninstall('tavily')` → 失败，文案如上。

- [ ] **Step 1:** 写测试；运行 `node --test packages/core/test/plugin-registry.test.ts`，预期 FAIL。
- [ ] **Step 2:** 实现。
- [ ] **Step 3:** 测试 PASS，全量无回归。
- [ ] **Step 4:** 提交。

### Task 3: 安装流水线：文件夹、zip、Git、市场

**Files:**
- Create: `packages/core/src/plugins/install.ts`、`packages/core/src/plugins/sources.ts`、`packages/core/src/plugins/market.ts`
- Modify: `packages/core/package.json`
- Test: `packages/core/test/plugin-install.test.ts`、`packages/core/test/plugin-market.test.ts`

**Interfaces:**
- Consumes: Task 1、Task 2
- Produces:
  - `type InstallSource = { kind: 'folder'; path: string } | { kind: 'zip'; path: string } | { kind: 'git'; url: string; ref?: string } | { kind: 'market'; marketUrl: string; name: string }`
  - `interface InstallPreview { token: string; manifest: PluginManifest; servers: { name: string; type: 'stdio' | 'http'; commandLine?: string; url?: string; cwd: string }[]; skills: string[]; problems: string[] }`
  - `PluginService.prepareInstall(src: InstallSource): Promise<InstallPreview>`
  - `PluginService.confirmInstall(token: string): Promise<void>`、`PluginService.cancelInstall(token: string): Promise<void>`
  - `interface MarketEntry { name: string; description: string; version: string; source: { git: string; ref?: string; path?: string } }`
  - `PluginService.listMarket(marketUrl: string): Promise<MarketEntry[]>`、`addMarket(url: string)`、`removeMarket(url: string)`

**思路:**
- `prepareInstall`：把来源取到 `<root>/tmp/plugin-<随机>/`：文件夹复制、zip 解压、Git `git clone --depth 1 [--branch <ref>] <url> <tmp>` 后记 `git rev-parse HEAD`；市场条目先找到对应 `MarketEntry`，再按其 `source` 克隆，取 `path` 子目录。然后 `readPluginBundle`、查重名、生成预览（stdio 命令行用 `${config.*}` 占位原样显示，`${PLUGIN_ROOT}` 显示为最终安装路径），返回 `token`。
- `confirmInstall`：把临时目录移到 `plugins/<name>/`，登记（来源与 commit），然后按 Task 2 的规则进入未连接状态。
- 任何一步失败或 `cancelInstall`：删除临时目录。未确认的 token 30 分钟后自动清理。
- 市场：`addMarket` 只接受 `https://` Git 地址；`listMarket` 浅克隆市场仓库到 `<root>/cache/markets/<sha256(url) 前 16 位>/`（已有就 `git fetch --depth 1` 后重置），读取根目录的 `marketplace.json`，结构不合规的条目跳过并计入提示。
- zip 解压库：选一个纯 JS、能按条目流式读取的库，锁定精确版本；解压时逐条校验路径和累计大小。

**约束:**
- `git` 子进程用 `runProcess`（不经 shell，参数数组传递），超时 120 秒，环境变量加 `GIT_TERMINAL_PROMPT=0`。
- 错误文案：`zip 包含不安全的路径：<entry>`；`zip 解压后超过 100 MB`；`zip 条目超过 5000 个`；`只支持 https:// 开头的 Git 地址`；`市场里没有这个插件：<name>`。

**验收:**
- `文件夹安装`：fixtures `ok-plugin` → 预览含 stdio 命令行；确认后 `plugins/ok-plugin/` 存在且登记来源 `local`。
- `取消清理`：`prepareInstall` 后 `cancelInstall` → 临时目录不存在，未登记。
- `zip 逃逸`：条目 `../evil.txt` → 失败，文案如上，临时目录已删。
- `zip 炸弹`：解压后 101 MB → 失败。
- `Git 安装`：用测试内创建的本地裸仓库，通过 `https` 校验之外的测试注入跑通克隆 → 登记 `commit` 等于仓库 HEAD。
- `非 https`：`git@github.com:x/y` → 失败，文案如上。
- `重名`：再装一次同名 → `已安装同名插件：ok-plugin`。
- `市场`：本地测试仓库含 `marketplace.json`（两个条目，一个合规一个缺 `source`）→ `listMarket` 返回一个条目；按名字安装成功，登记来源 `market`。

- [ ] **Step 1:** 选定并核实 zip 库；写测试；运行 `node --test packages/core/test/plugin-install.test.ts packages/core/test/plugin-market.test.ts`，预期 FAIL。
- [ ] **Step 2:** 实现。
- [ ] **Step 3:** 测试 PASS，全量无回归。
- [ ] **Step 4:** 提交。

### Task 4: 检查更新与更新

**Files:**
- Create: `packages/core/src/plugins/update.ts`
- Test: `packages/core/test/plugin-update.test.ts`

**Interfaces:**
- Consumes: Task 2、Task 3
- Produces:
  - `PluginService.checkUpdates(): Promise<{ name: string; current: string; latest: string }[]>`
  - `PluginService.prepareUpdate(name: string): Promise<InstallPreview & { commandChanges: { server: string; before: string | null; after: string | null }[] }>`
  - `PluginService.confirmUpdate(token: string): Promise<void>`

**思路:**
- Git 来源：`git ls-remote <url> <ref 或 HEAD>` 拿远端 commit，与登记的不同即有更新；`latest` 显示为远端 commit 前 7 位。市场来源：重新读市场，版本号不同或 commit 不同即有更新。本地来源、预装插件不参与。
- `prepareUpdate` 走 Task 3 的取源与校验，额外对比新旧每个 stdio server 的命令行，生成 `commandChanges`（新增、删除、改动都列出）。
- `confirmUpdate`：断开旧 server → 旧目录改名为备份 → 新目录就位 → 用原有的配置值重新连接；任一步失败则恢复备份并重连旧版本。新版本新增了必填配置时，更新后状态为 `not_connected`。

**验收:**
- `发现更新`：本地测试仓库新增一次提交 → `checkUpdates` 列出该插件。
- `命令变化`：新版本改了 `args` → `commandChanges` 含该 server 的前后命令行。
- `失败回滚`：新版本清单不合规 → `prepareUpdate` 失败，旧版本仍 `connected`。
- `安装失败回滚`：模拟移动新目录失败 → 旧目录恢复，旧 server 重新连接。
- `保留配置`：更新后无需重新填写已有配置。

- [ ] **Step 1:** 写测试；运行 `node --test packages/core/test/plugin-update.test.ts`，预期 FAIL。
- [ ] **Step 2:** 实现。
- [ ] **Step 3:** 测试 PASS。
- [ ] **Step 4:** 提交。

### Task 5: 预装搜索插件：DeepSeek（自封装 MCP）与 Tavily（官方 MCP）

**Files:**
- Create: `packages/builtin-plugins/deepseek/minibot-plugin.json`、`packages/builtin-plugins/deepseek/mcp.json`、`packages/builtin-plugins/deepseek/server.mjs`、`packages/builtin-plugins/tavily/minibot-plugin.json`、`packages/builtin-plugins/tavily/mcp.json`
- Modify: `packages/core/src/plugins/registry.ts`、`apps/desktop/electron-builder.json`、`apps/desktop/src/main.cts`
- Test: `packages/core/test/builtin-deepseek.test.ts`、`packages/core/test/builtin-tavily.test.ts`

**Interfaces:**
- Consumes: Task 2；`McpManager`（第 3 期，含 OAuth）
- Produces:
  - 预装插件专用的替换变量 `${RUNTIME}`（只对 `builtin: true` 插件生效，替换为 `process.execPath`，并给该 server 环境加 `ELECTRON_RUN_AS_NODE=1`）
  - DeepSeek 插件的连接值支持 `{ providerId: string }`（复用已有服务的 Key）或 `{ api_key: string }`

**思路:**
- **DeepSeek server（`server.mjs`）**：不依赖任何 npm 包的单文件 stdio MCP server，实现 MCP 早期以 `initialize` 握手的协议版本中 tools 所需的最小部分（`initialize`、`notifications/initialized`、`tools/list`、`tools/call`、`ping`、取消通知），第 3 期的客户端会按兼容规则与它通信。Key 从环境变量 `DEEPSEEK_API_KEY` 读。
  - `deepseek_search`：`POST https://api.deepseek.com/v1/tools/search`，参数照官方：`query`（必填，1–128 字符，支持 `site:`、`-site:`、`lang:`、`after:`、`before:`、引号短语与排除）、`count`（1–50，默认 10）、`ori_question`（可选，1–128）、`localization`（可选，IP 地址）、`need_content`（可选，默认 false）。请求体只放模型给的字段，原样转发；成功时把官方 JSON 响应原样作为 text 内容返回。
  - `deepseek_fetch`：`POST https://api.deepseek.com/v1/tools/fetch`，参数 `url`（必填，≤ 8192 字符，http/https），原样转发，原样返回。
  - 非 200：`isError: true`，内容为 `DeepSeek 返回 HTTP <status>：<官方错误 JSON 原文>`；网络错误 `网络错误：<message>`。不重试。
  - 工具描述按官方文档写清每个参数的含义与约束。
- **DeepSeek 连接**：表单二选一：“使用已有的 DeepSeek 服务”（下拉列出 `presetId` 为 `deepseek` 的服务）或“填写 API Key”。选服务时只记 `providerId`，每次启动 server 时从密钥库取该服务当前的 Key 注入 `DEEPSEEK_API_KEY`；服务不存在或没有 Key → 状态 `error`，提示 `所选的 DeepSeek 服务不存在或没有 API Key`。
- **Tavily 插件**：只有清单和 `mcp.json`：`{ "mcpServers": { "tavily": { "url": "https://mcp.tavily.com/mcp/", "headers": { "Authorization": "Bearer ${config.api_key}" } } } }`。连接表单二选一：填 API Key（默认），或“用 Tavily 账号登录”——选它时该 server 改为 `auth: 'oauth'`、不带 `Authorization` 头，走第 3 期的 `login`。工具以官方 server 返回为准，原样交给 bot。
- 打包：`electron-builder.json` 的 `extraResources` 把 `packages/builtin-plugins` 拷到 `resources/builtin-plugins`；`main.cts` 把该路径（开发模式为仓库内路径）作为 `builtinPluginsDir` 传给内核。

**约束:**
- 不把 Tavily Key 放进 URL 查询参数。
- `server.mjs` 只用 Node 24 内置模块与全局 `fetch`。

**验收:**
- `DeepSeek 协议`：用第 3 期的 `McpManager` 以 `node` 启动 `server.mjs`（测试里 `${RUNTIME}` 即当前 `node`）→ `connected`，工具为 `deepseek_search`、`deepseek_fetch`，`inputSchema` 字段与官方一致。
- `DeepSeek 原样转发`：用注入的上游地址（环境变量 `DEEPSEEK_BASE_URL`，仅测试使用）指向本地假服务 → 调用 `deepseek_search({query:'x', count:3, need_content:true})`，假服务收到的请求体与之完全相同，带 `Authorization: Bearer <key>`；返回 text 等于假服务的响应原文。
- `DeepSeek 错误原样`：假服务返回 402 和官方错误 JSON → `isError: true`，内容含状态码与原文。
- `复用服务 Key`：连接时选 `providerId`，之后把该服务的 Key 改成新值并重连 → 假服务收到新 Key。
- `复用服务被删`：删除该服务后重连 → 状态 `error`，提示如上。
- `Tavily 配置`：用 Key 连接 → 生成的 server 配置为 http、地址如上、请求头 `Authorization` 为 secret；URL 不含 Key。
- `Tavily OAuth`：选账号登录 → server 配置 `auth: 'oauth'`，无 `Authorization` 头。
- 手动（需要真实 Key，作者本人执行）：两家各连接一次，调用一次搜索并截图结果。

- [ ] **Step 1:** 写测试；运行 `node --test packages/core/test/builtin-deepseek.test.ts packages/core/test/builtin-tavily.test.ts`，预期 FAIL。
- [ ] **Step 2:** 实现插件文件、连接逻辑和打包配置。
- [ ] **Step 3:** 测试 PASS；`npm run build --workspace @minibot/desktop` 通过；`npm run pack:dir --workspace @minibot/desktop` 产物里有 `resources/builtin-plugins/deepseek/server.mjs`。
- [ ] **Step 4:** 提交。

### Task 6: 搜索引擎切换

**Files:**
- Create: `packages/core/src/web/search-tools.ts`
- Modify: `packages/core/src/mcp/tools.ts`、`packages/core/src/kernel.ts`、`packages/core/src/server/dispatch.ts`
- Test: `packages/core/test/search-tools.test.ts`

**Interfaces:**
- Consumes: Task 2、Task 5；`ExtensionsFile.web.searchEngine`（第 2 期）
- Produces: `class SearchToolProvider implements ExternalToolProvider`；`PUT /api/extensions/web` 开始接受 `searchEngine: 'deepseek' | 'tavily'`

**思路:**
- `SearchToolProvider.toolsFor(bot)`：`bot.extensions.web` 为真、`searchEngine` 不是 `none`、对应预装插件已启用且其 server 已连接 → 返回该 server 的全部工具，名字保持官方原名（如 `tavily_search`、`deepseek_search`，不加 `<shortName>__` 前缀），来源 `{ kind: 'web' }`，`summarize` 为 `<引擎名>：<工具名>` 加主要参数（`query` 或 `url`）。
- `McpToolProvider` 跳过 `deepseek`、`tavily` 两个预装插件的 server；这两个插件也不出现在 bot 的插件开关里（由联网开关管）。
- 选择未连接的引擎 → 400 `所选搜索引擎尚未连接`。已选引擎之后变成未连接 → 设置页显示提示，搜索工具不出现。

**约束:**
- 搜索插件工具名若与内置工具冲突，按第 1 期规则丢弃（理论上不会发生）。

**验收:**
- `只出现选中那家`：两家都已连接、选 `tavily` → 快照含 `tavily_search` 等，不含 `deepseek_*`；改选 `deepseek` 后下一轮相反。
- `联网关闭`：bot `web: false` → 两家都不出现，`web_fetch` 也不出现。
- `走 web 审批`：`edits` 档调用 `deepseek_search` → 直接执行；`ask` 档 → 请求 `source: 'web'`、勾选文案为“总是允许联网”。
- `不重复出现`：选中 `tavily` 时，快照里不存在 `tavily__tavily_search` 这类带前缀的重复工具。
- `选未连接的引擎`：→ 400，文案如上。

- [ ] **Step 1:** 写测试；运行 `node --test packages/core/test/search-tools.test.ts`，预期 FAIL。
- [ ] **Step 2:** 实现。
- [ ] **Step 3:** 测试 PASS，全量无回归。
- [ ] **Step 4:** 提交。

### Task 7: 插件页、市场与联网设置界面

**Files:**
- Create: `apps/renderer/src/settings/PluginsSection.tsx`、`apps/renderer/src/settings/PluginInstallDialog.tsx`、`apps/renderer/src/settings/PluginConnectDialog.tsx`、`apps/renderer/src/settings/MarketSection.tsx`
- Modify: `packages/core/src/server/dispatch.ts`、`apps/renderer/src/api.ts`、`apps/renderer/src/settings/ExtensionsPage.tsx`、`apps/renderer/src/settings/WebPage.tsx`、`apps/renderer/src/panel/SettingsPage.tsx`、`apps/renderer/src/i18n.ts`、`apps/desktop/src/main.cts`、`apps/desktop/src/preload.cts`
- Test: `packages/core/test/dispatch.test.ts`

**Interfaces:**
- Consumes: Task 2–6 的 `PluginService` 方法
- Produces: 接口 `GET /api/plugins`、`POST /api/plugins/prepare`、`POST /api/plugins/confirm`、`POST /api/plugins/cancel`、`POST /api/plugins/:name/connect`、`PATCH /api/plugins/:name`（`enabled`）、`DELETE /api/plugins/:name`、`GET /api/plugins/updates`、`POST /api/plugins/:name/prepare-update`、`POST /api/plugins/confirm-update`、`GET /api/markets`、`POST /api/markets`、`DELETE /api/markets`、`GET /api/markets/plugins?url=`；preload 新增选择文件夹 / zip 的系统对话框

**思路:**
- “扩展”页增加“插件”栏（放在 MCP 前）：预装的两个搜索插件置顶并标“搜索”；每行显示名称、版本、状态、来源，操作：连接 / 停用 / 删除（预装无删除）/ 检查更新。
- 安装对话框：三个入口（选文件夹、选 zip、填 Git 地址），以及“市场”栏（市场源列表、添加 / 移除、浏览与搜索条目、安装）。都先调 `prepare` 再显示确认页（名称、版本、MCP server 与完整命令行、skills 列表注明“下一版本支持”、问题提示），确认后进入连接对话框。
- 更新确认页在命令行有变化时，用 `warning` 状态色列出前后对比。
- 连接对话框按清单 `config` 生成表单（secret 字段用密码框）；DeepSeek 显示“使用已有服务 / 填写 Key”二选一；Tavily 显示“填写 Key / 用 Tavily 账号登录”二选一。
- 联网设置页加“搜索引擎”：无 / DeepSeek / Tavily，未连接的项置灰并带“去连接”链接（跳到扩展页插件栏）。
- bot 面板“扩展”一节增加插件列表开关（不含两个搜索插件）；插件行可展开，列出它的 MCP server，每项一个开关（写 `pluginExclusions`）。

**约束:**
- 文案（逐字）：栏名 `插件`；`市场`；状态 `未连接` / `已连接` / `出错`；`连接`；`检查更新`；确认页标题 `安装插件：{name}`；命令变化提示 `新版本改变了要在这台电脑上运行的命令`；skill 提示 `下一版本支持`；搜索引擎选项 `无`、`DeepSeek`、`Tavily`；未连接提示 `尚未连接，去插件页连接`。

**验收:**
- `接口不泄露`：`GET /api/plugins` 不含任何 secret 值。
- 手动：在临时 `MINIBOT_HOME` 下：用 fixtures 插件走文件夹安装（看到命令确认）→ 连接 → bot 面板开关 → 调用；用本地测试市场安装一次；在联网页切换搜索引擎；截图插件栏、确认页、连接对话框（DeepSeek 与 Tavily 两种）、联网页。

- [ ] **Step 1:** 写 dispatch 测试；运行 `node --test packages/core/test/dispatch.test.ts`，预期 FAIL。
- [ ] **Step 2:** 实现接口与界面。
- [ ] **Step 3:** 测试 PASS；`npm run build --workspace @minibot/renderer`、`npm run build --workspace @minibot/desktop`、`npm run lint` 通过；按验收手动检查并截图。
- [ ] **Step 4:** 提交。
