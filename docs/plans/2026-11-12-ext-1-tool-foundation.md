# 扩展第 1 期：工具底座 实现计划

> **For agentic workers:** Implement this plan task-by-task, in order. Each task's requirements include the Global Constraints below; each task's Interfaces block tells you the names and types neighboring tasks use. The plan gives approach and constraints only — you write the tests and the code. Steps use checkbox (`- [ ]`) syntax for tracking — tick each one as it is done.

**Goal:** 把写死的 6 个工具改成“内置工具 + 外部工具”，让后续的联网、MCP、Skill 能动态挂进工具列表，并按来源走审批、“总是允许”、结果截断和诊断。

**Architecture:** 新增 `ToolCatalog`：内核持有一份，外部工具通过 `ExternalToolProvider` 注册进来；`runTurn` 每轮开头向 catalog 要一份按 bot 计算的 `TurnToolset` 快照，这一轮所有模型调用和工具执行都用它。内置工具的执行路径保持不变；外部工具走新的统一路径（校验 → 审批 → 执行 → 截断 → 脱敏）。bot 配置新增扩展启用列表和两类新的“总是允许”条目。

**Tech Stack:** TypeScript 5.9.3（strict、`erasableSyntaxOnly`）、`node:test`、React 19 + Tailwind v4（桌面与手机网页层共用 `apps/renderer` 组件和 i18n）。

**Spec:** `docs/specs/2026-11-12-extensions-design.md` §5.1（另见 §2 反目标、§3 约束、§6 已定事项）。

## Global Constraints

- 不新增依赖。
- 相对导入写 `.ts` 后缀；不用 enum / namespace / 参数属性。
- 内置工具名（`read_file`、`write_file`、`edit_file`、`glob`、`grep`、`run_command`，以及第 5 期的 `load_skill`）永远不能被外部工具顶替；外部工具重名时外部那个被丢弃。
- 所有工具结果在出口经过 `secrets.redact`。
- 审批协议只增加字段、不改原有字段的含义：`ApprovalRequest` 原有的 `tool`、`summary`、`command`、`preview`、`canAlwaysAllow` 对内置工具的取值与现在完全相同。
- 诊断事件里外部工具只记来源类型 `web` / `mcp`，不记 server 名、URL、参数。
- 界面文案全部进 `apps/renderer/src/i18n.ts`；视觉遵守 `.claude/CLAUDE.md`。
- 测试：`node --test "packages/core/test/*.test.ts"`；类型检查：`npm run build --workspace @minibot/core`；界面：`npm run build --workspace @minibot/renderer`、`npm run build --workspace @minibot/mobile`；`npm run lint`。

## Review Focus

- 一轮进行到一半时用户停用了某个扩展 → 本轮继续用开头的快照，不报“未知工具”；下一轮才消失（Task 2）。
- 历史里有已经不存在的外部工具的 `tool_use`（工具被停用或 server 删除）→ 三种 API 格式照常发送历史，不因此失败（Task 2）。
- 模型调用了不在本轮快照里的外部工具名 → 返回 `未知工具：<name>`，计为模型错误，不触发诊断错误事件（Task 2）。
- 外部工具执行时抛异常或返回超大文本 → 结果截断并写入 outputs 目录，对话继续（Task 2）。
- 旧版手机端收到外部工具的审批卡片 → 仍能显示 `summary` 并批准 / 拒绝（Task 4，靠只加字段保证）。

---

### Task 1: bot 配置：扩展启用列表与新的“总是允许”条目

**Files:**
- Modify: `packages/core/src/config/types.ts`、`packages/core/src/config/config.ts`、`packages/core/src/kernel.ts`
- Test: `packages/core/test/config.test.ts`、`packages/core/test/kernel.test.ts`

**Interfaces:**
- Produces:
  - `interface BotExtensions { web: boolean; plugins: string[]; mcpServers: string[]; skills: string[] }`
  - `Bot` 新增 `extensions: BotExtensions`、`allowWeb: boolean`、`allowedMcpTools: string[]`（条目格式 `<serverId>/<原始工具名>`）
  - `AppConfig` 新增 `extensionsMigrated?: true`
  - `Kernel.updateBot` 的 patch 接受 `extensions`、`allowWeb`、`allowedMcpTools`
  - `Kernel.enableForMainBot(kind: keyof Omit<BotExtensions, 'web'>, id: string): Promise<void>`（后续各期“新加的扩展默认只对主 bot 启用”用它）
  - `Kernel.removeFromAllBots(kind: keyof Omit<BotExtensions, 'web'>, id: string): Promise<void>`（卸载 / 删除时用）

**思路:**
- `migrate()` 读 bot 时：`extensions` 缺失或字段类型不对时补默认值 `{ web: false, plugins: [], mcpServers: [], skills: [] }`，数组里非字符串剔除并去重；`allowWeb` 缺失为 `false`；`allowedMcpTools` 同 `allowedCommands` 的过滤规则。
- 一次性迁移放在内核 `init()`：`config.extensionsMigrated` 不为 `true` 时，把主 bot 的 `extensions.web` 设为 `true` 并保存，然后写 `extensionsMigrated: true` 到 config。其他 bot 保持 `false`。
- 新建 bot：初始化流程创建的主 bot `web: true`；之后新增的 bot `web: false`。
- `enableForMainBot` / `removeFromAllBots` 都在对应 `bot.json` 的路径锁里读改写。

**约束:**
- `updateBot` 校验：`extensions` 必须四个字段齐全且类型正确，否则 `KernelError('invalid', 'extensions 格式无效')`；`allowedMcpTools` 每项必须匹配 `^[^/]+/.+$`，否则 `KernelError('invalid', 'allowedMcpTools 格式无效')`。
- 迁移只执行一次：用户之后关掉主 bot 的联网，重启不得被改回。

**验收:**
- `migrate 补默认扩展`：旧 bot.json（无新字段）→ `extensions` 为全空、`web: false`，`allowWeb: false`，`allowedMcpTools: []`。
- `迁移只给主 bot 开联网`：两个 bot、config 无 `extensionsMigrated` → 启动后主 bot `web: true`、另一个 `false`，config 有 `extensionsMigrated: true`。
- `迁移不重复`：迁移后把主 bot `web` 改成 `false`，重启内核 → 仍为 `false`。
- `enableForMainBot`：调用 `('mcpServers', 's1')` 两次 → 主 bot 的 `mcpServers` 为 `['s1']`，其他 bot 不变。
- `removeFromAllBots`：两个 bot 都启用了 `s1` 且 `allowedMcpTools` 含 `s1/x` → 调用后两者都不含 `s1`，`allowedMcpTools` 也不再含 `s1/` 开头的条目。
- `updateBot 拒绝坏 extensions`：缺 `skills` 字段 → `invalid`。

- [ ] **Step 1:** 写上述测试；运行 `node --test packages/core/test/config.test.ts packages/core/test/kernel.test.ts`，预期 FAIL。
- [ ] **Step 2:** 按思路与约束实现。
- [ ] **Step 3:** 再跑同一命令，预期 PASS；跑全量 `node --test "packages/core/test/*.test.ts"` 无回归。
- [ ] **Step 4:** 提交。

### Task 2: ToolCatalog、每轮快照与外部工具执行路径

**Files:**
- Create: `packages/core/src/tools/catalog.ts`、`packages/core/src/tools/output.ts`
- Modify: `packages/core/src/tools/registry.ts`、`packages/core/src/tools/run-command.ts`、`packages/core/src/agent/loop.ts`、`packages/core/src/kernel.ts`、`packages/core/src/index.ts`
- Test: `packages/core/test/catalog.test.ts`、`packages/core/test/loop.test.ts`、`packages/core/test/registry.test.ts`

**Interfaces:**
- Consumes: `Bot.extensions`（Task 1）
- Produces:
  - `type ToolSource = { kind: 'builtin' } | { kind: 'web' } | { kind: 'mcp'; serverId: string; serverName: string; toolName: string }`
  - `interface ExternalCallContext { bot: Bot; threadId: string; signal: AbortSignal; supportsImages: boolean }`
  - `interface ExternalTool { spec: ToolSpec; source: Exclude<ToolSource, { kind: 'builtin' }>; validate?(input: Record<string, unknown>): string | null; summarize(input: Record<string, unknown>): string; preview?(input: Record<string, unknown>): string | undefined; run(input: Record<string, unknown>, ctx: ExternalCallContext): Promise<ToolOutput> }`
  - `interface ExternalToolProvider { toolsFor(bot: Bot): Promise<ExternalTool[]> }`
  - `class ToolCatalog { register(p: ExternalToolProvider): void; snapshot(bot: Bot): Promise<TurnToolset> }`
  - `interface TurnToolset { specs: ToolSpec[]; external(name: string): ExternalTool | undefined }`
  - `ToolEnv` 新增 `toolset: TurnToolset`
  - `TurnDeps` 新增 `snapshotTools(bot: Bot): Promise<TurnToolset>`
  - `Kernel.tools: ToolCatalog`（只读属性，后续各期在内核里注册 provider）
  - `clipToOutputs(text: string, outputsDir: string): Promise<string>`（从 `run-command.ts` 抽出，供外部工具复用）

**思路:**
- `snapshot`：内置 `TOOL_SPECS` 在前，随后按注册顺序合并各 provider 的工具；与内置工具重名、或与已收录外部工具重名的丢弃（后者在 diag 写一条 `warn`，不发事件）。
- `runTurn` 开头调用一次 `deps.snapshotTools(bot)`，放进 `ToolEnv.toolset`；`systemForEstimate` 和每次 `callModel` 的 `tools` 都用 `toolset.specs`。本轮内不重新取。
- `runTool`：工具名在内置集合里 → 原路径不变；否则 `toolset.external(name)` 找不到 → `未知工具：<name>`；找到 → 走外部路径：可选的 `validate` → 审批（Task 3 提供判断函数，本 task 先按“总是询问”接上，Task 3 替换）→ `run` → 结果经 `clipToOutputs` → `secrets.redact`。
- `run` 抛异常 → `工具执行失败：<message>`；中断时 → `CANCELLED_TEXT`，状态 `cancelled`。
- `clipToOutputs` 保持 `run-command` 现有截断规则不变（`OUTPUT_LIMIT` 30000、首尾各保留 `OUTPUT_KEEP` 15000、写入 outputs 目录并沿用其清理）。`runCommand` 改为调用它，行为不变。
- `reportTool`：外部工具名在事件里记为来源类型 `web` / `mcp`；完整日志同样不记参数。
- `ExternalCallContext.supportsImages` 取当前模型的 `vision`（来自 `resolveModel`）。

**约束:**
- 历史消息不做任何过滤：已不存在工具的 `tool_use` / `tool_result` 原样进入 `historyForModel`。
- 内置工具执行逻辑、文案、审批行为零变化（现有测试全部原样通过）。

**验收:**
- `快照合并`：注册一个提供 `fake__echo` 的 provider → `specs` 依次为 6 个内置工具和 `fake__echo`。
- `外部工具不能顶替内置`：provider 提供名为 `read_file` 的工具 → `specs` 里只有一个 `read_file`，且执行时走内置逻辑。
- `本轮使用快照`：provider 在第一次 `callModel` 之后改为不再提供 `fake__echo`，模型在同一轮第二次调用中请求 `fake__echo` → 正常执行；下一轮请求 → `未知工具：fake__echo`。
- `未知工具不报诊断错误`：模型请求 `nope__x` → 结果状态 `error`、内容以 `未知工具` 开头，diag 没有 `kind: 'error'` 事件。
- `外部结果截断`：`run` 返回 40000 字符 → 结果含 `完整输出见`，outputs 目录多一个文件。
- `外部结果脱敏`：`run` 返回包含已知 Key 的文本 → 结果里是 `[REDACTED_API_KEY]`。
- `外部工具异常`：`run` 抛 `Error('boom')` → 结果 `工具执行失败：boom`，下一轮正常。
- `历史含消失工具`：历史里有 `old__tool` 的 `tool_use`/`tool_result`，快照里没有它 → `callModel` 收到的 messages 仍包含这两块。

- [ ] **Step 1:** 写上述测试；运行 `node --test packages/core/test/catalog.test.ts packages/core/test/loop.test.ts packages/core/test/registry.test.ts`，预期 FAIL。
- [ ] **Step 2:** 按思路与约束实现。
- [ ] **Step 3:** 跑同一命令 PASS，再跑全量无回归；`npm run build --workspace @minibot/core` 通过。
- [ ] **Step 4:** 提交。

### Task 3: 外部工具的审批与“总是允许”

**Files:**
- Modify: `packages/core/src/approval/policy.ts`、`packages/core/src/approval/broker.ts`、`packages/core/src/tools/registry.ts`、`packages/core/src/kernel.ts`、`packages/core/src/db/approval-log.ts`
- Test: `packages/core/test/approval.test.ts`、`packages/core/test/approval-extras.test.ts`

**Interfaces:**
- Consumes: `ExternalTool.source`（Task 2）、`Bot.allowWeb` / `Bot.allowedMcpTools`（Task 1）
- Produces:
  - `decideExternal(mode: ApprovalMode, kind: 'web' | 'mcp'): 'allow' | 'ask'`
  - `ApprovalRequest.tool` 类型放宽为 `string`
  - `ApprovalRequest` 新增可选字段 `source?: 'web' | 'mcp'`、`serverName?: string`、`alwaysKind?: 'command' | 'web' | 'mcp_tool'`、`mcpToolKey?: string`（`<serverId>/<原始工具名>`）
  - `ToolEnv` 新增 `isExternalAllowed?: (tool: ExternalTool) => Promise<boolean>`

**思路:**
- `decideExternal`：`web` → `ask` 档问，`edits`、`auto` 放行；`mcp` → `ask`、`edits` 档问，`auto` 放行。
- 外部路径：`decideExternal` 为 `ask` 时，先用 `isExternalAllowed`（内核在 bot.json 路径锁里读最新 bot：`web` 看 `allowWeb`，`mcp` 看 `allowedMcpTools` 是否含 `mcpToolKey`）；命中就记 `logAllowlisted` 并放行；否则发审批请求，`canAlwaysAllow: true`，`alwaysKind` 按来源填。
- 审批请求 `tool` 填模型看到的工具名，`summary` 用 `ExternalTool.summarize`，`preview` 用 `ExternalTool.preview`（截断规则复用 `clipPreview`，并脱敏）。
- `respondApproval(id, true, always=true)`：按 `alwaysKind` 分别把 `command` 写进 `allowedCommands`（现有逻辑）、把 `allowWeb` 设 `true`、把 `mcpToolKey` 加进 `allowedMcpTools`。
- 内置工具的请求不填新字段。

**约束:**
- MCP server 自报的任何标注（`readOnlyHint` 等）都不参与判断。
- 决策日志的 `tool` 列写模型看到的工具名。

**验收:**
- `decideExternal 矩阵`：`(ask,web)=ask`、`(edits,web)=allow`、`(auto,web)=allow`、`(ask,mcp)=ask`、`(edits,mcp)=ask`、`(auto,mcp)=allow`。
- `外部审批请求字段`：`ask` 档调用 mcp 工具 → 请求含 `source: 'mcp'`、`serverName`、`alwaysKind: 'mcp_tool'`、`canAlwaysAllow: true`。
- `总是允许 mcp 工具`：批准并勾选 always → bot 的 `allowedMcpTools` 含该键；再次调用同一工具不再发请求，日志记 `decided_by = 'allowlist'`。
- `总是允许联网`：同上，`allowWeb` 变 `true`，之后联网工具不再询问。
- `撤销后恢复询问`：把 `allowedMcpTools` 清空 → 下一次调用重新询问。
- `内置请求不变`：`run_command` 的审批请求不含 `source`、`alwaysKind` 等新字段。

- [ ] **Step 1:** 写上述测试；运行 `node --test packages/core/test/approval.test.ts packages/core/test/approval-extras.test.ts`，预期 FAIL。
- [ ] **Step 2:** 按思路与约束实现，并把 Task 2 里的临时“总是询问”换成这里的判断。
- [ ] **Step 3:** 跑同一命令 PASS，再跑全量无回归。
- [ ] **Step 4:** 提交。

### Task 4: 审批卡片与白名单界面（桌面与手机）

**Files:**
- Modify: `apps/renderer/src/main/ApprovalCard.tsx`、`apps/renderer/src/main/CommandAllowlistDialog.tsx`、`apps/renderer/src/panel/SettingsPage.tsx`、`apps/renderer/src/api.ts`、`apps/renderer/src/i18n.ts`、`apps/mobile/src/ApprovalBar.tsx`

**Interfaces:**
- Consumes: `ApprovalRequest` 的新字段（Task 3）、`Bot.allowWeb` / `Bot.allowedMcpTools`（Task 1）
- Produces: `BotPatch` 新增 `extensions`、`allowWeb`、`allowedMcpTools`

**思路:**
- 卡片：有 `source` 时，在标题下多一行来源：`web` 显示“联网”，`mcp` 显示“MCP · <serverName>”，再显示工具名。“总是允许”勾选框的文案按 `alwaysKind` 切换。
- 白名单对话框改名“总是允许”，分三组：命令（现有）、联网（一个开关项，`allowWeb` 为真时显示、可移除）、MCP 工具（按 `serverId` 分组列出 `allowedMcpTools`，可逐条移除）。只有命令组能手动添加。
- bot 面板设置页里白名单摘要同样列出三类。
- 手机 `ApprovalBar` 同步显示来源行和对应的勾选文案。

**约束:**
- 新文案（逐字）：`approval.sourceWeb` = `联网`；`approval.sourceMcp` = `MCP · {name}`；`approval.alwaysWeb` = `总是允许联网`；`approval.alwaysMcp` = `总是允许这个工具`；`allowlist.groupCommands` = `命令`；`allowlist.groupWeb` = `联网`；`allowlist.groupMcp` = `MCP 工具`。
- 不认识的 `source` 值按没有 `source` 处理（只显示 `summary`）。

**验收（手动）:**
- 用 Task 2 的假 provider 在 `MINIBOT_HOME` 临时目录下启动桌面端：`ask` 档触发一次外部工具 → 卡片有来源行、勾选文案为“总是允许这个工具”；勾选批准后白名单对话框 MCP 组出现该条，移除后再次触发会询问。截图卡片与对话框。
- 手机网页层构建通过，`ApprovalBar` 渲染带 `source` 的请求不报错。

- [ ] **Step 1:** 按思路实现。
- [ ] **Step 2:** 运行 `npm run build --workspace @minibot/renderer`、`npm run build --workspace @minibot/mobile`、`npm run lint`，全部通过；`node --test packages/core/test/i18n-lint.test.ts` 通过。
- [ ] **Step 3:** 按验收做手动检查并截图。
- [ ] **Step 4:** 提交。
