# minibot 核心底座 设计文档

日期：2026-11-07　状态：待批准
依据：`requirements.md`（用户已确认，2026-11-05）。本文是其技术设计；两者冲突时以需求为准。

## 1. 意图与动机

做一个**自己完全掌控**的桌面 AI 助理"最小底座"，形态类似 Grok Bot（xAI）及开源仿品 OpenMausBot / OpenBot：多个有人设的 bot 像聊天联系人一样排列，能在本机动手干活，危险操作要人批准，有长期记忆，bot 之间能互相委托。

动机：现有开源项目约一半与商业服务绑定（OpenMausBot 的 Boat 云电脑、Composio、Cloud 套餐、`enterprise/` 非开源许可）。minibot 自带 agent 内核，自己接入三种模型 API 格式，不调用外部 agent CLI，不依赖任何账号或云服务。

首要质量目标：代码精简，但达到生产级标准、功能正常；**尽可能减少以后出现的错误**——移动部件少、单一语言、可独立测试、配置即数据。

## 2. 目标 / 非目标 / 反目标

**目标**
- 里程碑 1（单 bot 闭环）：首次初始化、主 bot、三种模型格式、文件/命令工具、审批、多线程、记忆。
- 里程碑 2：多 bot、委托（同步 / 异步）、群聊。
- Electron + TypeScript 全栈；内核与界面分离，内核在主进程提供本机 HTTP + WebSocket 接口。
- 平台：Windows + Linux。界面只做简体中文，文字抽成语言包。

**非目标（第一版明确不做）**
skill、MCP、定时与事件触发（含 webhook）、浏览器自动化、桌面 GUI 操控、功能介绍动画、界面引导、中继、手机端 App、联网搜索/抓取。

**反目标（即使能跑也算失败）**
- 需要注册 minibot 自己的账号或依赖我方云服务。
- 新建 bot 默认处于"全自动"。
- API Key 以明文落盘，或出现在对话记录、日志、记忆、发给模型的内容里。
- 记忆被写入后无从查证、无法撤销。
- 不同模型格式之间审批行为不一致。

## 3. 约束

- 运行时：Electron 45（内置 Node 24.22），TypeScript。
- SQLite 使用 `node:sqlite`（Node 24.15 起为 release candidate，无需 flag，构造参数支持 `timeout`），启动后执行 `PRAGMA journal_mode=WAL`。好处是免去原生模块在双平台的 rebuild。数据库访问收在一个模块里，日后可换 `better-sqlite3`。
- 除调用用户配置的模型 API 外，不依赖云服务，不需要账号。
- API Key 不明文存储：系统密钥库加密，或由环境变量提供、不落盘。
- 依赖尽量少；不引入需要原生编译的依赖（`@vscode/ripgrep` 为预编译二进制，除外）。

## 4. 架构

### 4.1 结构

```
minibot/
  packages/core/     # 内核：bot、agent 循环、模型适配器、工具、审批、记忆、存储
  apps/desktop/      # Electron：主进程承载内核 + HTTP/WS 服务；渲染进程为界面
```

- 内核运行在 Electron 主进程，对外只暴露本机 HTTP + WebSocket 接口，**界面只通过这套接口通信**。目的：为后续安卓端（直接 APK，不上架）与自建中继预留。
- 审批请求以事件形式经 WebSocket 抛给前端，前端回传答复，审批逻辑只存在于内核里一处。
- 内核不依赖 Electron 的 UI 部分，可用假模型独立测试；仅密钥库（`safeStorage`）由主进程注入。

### 4.2 本机接口鉴权

- 内核每次启动生成高熵随机令牌，只放在内存；经 preload（`contextBridge`）只暴露给本应用渲染进程。
- 只绑定 `127.0.0.1`。
- HTTP：令牌放请求头；校验 `Host` 必须是 `127.0.0.1:<端口>`（防 DNS rebinding）；不返回任何 CORS 允许头。
- WebSocket：浏览器不对 WS 做 CORS 限制，握手时必须校验 `Origin`（只认本应用来源）和 `Host`；令牌不放 URL（会进日志），由连接后的第一条消息携带，超时未鉴权即断开。
- 以后的安卓端和中继使用另一套配对令牌，与本令牌分开，届时再设计。

## 5. 模型接入

- **三种格式**：OpenAI Chat Completions（`/v1/chat/completions`）、OpenAI Responses（`/v1/responses`）、Anthropic Messages（`/v1/messages`）。三种格式均可自定义 base URL，兼容第三方。
- **供应商**：在设置里统一添加供应商（格式 + base URL + key）；每个 bot 选一个供应商并填写模型名。
- **预设是模板，供应商是实例**：添加供应商时可选"预设"（见 5.1）自动填好格式和 base URL，用户只需填 key；也可选"自定义"手填。同一预设可添加多个供应商（各自的 key / 地址）。预设只是数据，预设选中后即成为普通供应商，之后与自定义完全一致。
- 每个供应商可"测试连接"：发一条极短请求，区分成功 / Key 错误 / 地址错误 / 网络错误并给出可读提示。
- 上下文窗口大小：按所选预设预填，用户可在 bot 设置里修改；预设没有已核实的数值或用自定义时按 128k。已核实的：DeepSeek 为 1M。火山 Coding Plan / Agent Plan 的预设默认为 256k（所列模型里的最小值），并附已知模型表；模型名命中表中条目时按表填写。表中 `doubao-seed-2.0-mini` 为 256k，其余模型（`doubao-seed-2.1-pro`、`doubao-seed-2.1-lite`、`doubao-seed-evolving`、`glm-5.3`、`glm-5.3-flash`、`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4.1-flash`、`deepseek-v4.1-flash-economy`、`kimi-k2.8-preview`、`kimi-k3`、`kimi-k3.1-pro`）为 1024k。来源：火山控制台模型列表，用户于 2026-11-08 提供。`ark-code-latest` 的实际模型由控制台决定，按默认值处理。
- 输出上限：只有 Anthropic Messages 格式必须传 `max_tokens`，默认 128000（主流模型的最大输出都不低于此值），可在 bot 设置里调小；另外两种格式不传，由服务端用默认值。

### 5.1 供应商预设

预设存为数据文件（预设 id、显示名、格式、base URL、备注、默认上下文窗口、可选思考档位），不写进代码；改地址只改数据。三种自定义项（格式固定、base URL 手填）也在列表里。第一版只提供下表 8 项，其他服务商用三种自定义项接入。

| 预设 | 格式 | base URL | 备注 |
|---|---|---|---|
| OpenAI Chat Completions 自定义 | Chat Completions | 用户填 | |
| OpenAI Responses 自定义 | Responses | 用户填 | |
| Anthropic 自定义 | Anthropic Messages | 用户填 | |
| DeepSeek | Chat Completions | `https://api.deepseek.com` | |
| 火山 Coding Plan | Responses | `https://ark.cn-beijing.volces.com/api/coding/v3` | 用 Coding Plan 专属 Key。**必须是 coding 路径**，普通方舟地址 `/api/v3` 不扣套餐额度、另行计费。官方 Codex 示例用 Responses；Chat Completions 仅见于一篇旧文章（模型 `doubao-seed-code`），**须先实测**连通与工具调用，通过后再切换默认格式。模型可填具体名（如 `doubao-seed-2.1-pro`、`glm-5.3`、`deepseek-v4-pro`、`kimi-k3`）或 `ark-code-latest`（在控制台切换，3–5 分钟生效） |
| 火山 Coding Plan（Anthropic） | Anthropic Messages | `https://ark.cn-beijing.volces.com/api/coding` | 同上 Key 与模型 |
| 火山 Agent Plan | Responses | `https://ark.cn-beijing.volces.com/api/plan/v3` | 需 Agent Plan **专属 Key**（Coding Plan 的 Key 不通用）；官方文档强调其他 Base URL 无法在 Agent Plan 中使用。官方示例为 Responses，Chat Completions 须先实测；默认模型 `ark-code-latest`，可用模型随套餐档位不同 |
| 火山 Agent Plan（Anthropic） | Anthropic Messages | `https://ark.cn-beijing.volces.com/api/plan` | 同上 Key |

- 地址已于 2026-11-07 逐个核对，DeepSeek 与火山均来自官方文档；并对各地址发无效 key 请求确认服务可达（均返回 401）。这不能证明 Chat Completions 在套餐类 key 上可调用，实现时仍须对每个预设做一次真实连通与工具调用实测。
- 来源：DeepSeek https://api-docs.deepseek.com/ ；火山 Coding Plan https://docs.volcengine.com/docs/ark/coding-plan-personal-ai-codex?lang=zh ；火山 Agent Plan https://docs.volcengine.com/docs/ark/agent-plan-personal-get-started?lang=zh 、https://docs.volcengine.com/docs/ark/agent-plan-personal-codex?lang=zh 。

### 5.1.1 思考档位

- 每个 bot 有一个思考档位设置，可选值由所用供应商的预设决定；选"默认"时不传任何思考参数，由服务端按模型默认处理。
- 档位取值：`off`、`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。其中 `off` 统一映射为 `thinking: {"type": "disabled"}`（三种格式都一样），其余档位按格式映射：
  - Chat Completions：顶层 `reasoning_effort: <档位>`
  - Responses：`reasoning: {"effort": <档位>}`
  - Anthropic Messages：`output_config: {"effort": <档位>}`
- 各预设可选的档位：

| 预设 | 可选档位 | 依据 |
|---|---|---|
| OpenAI Chat Completions 自定义 | 全部：`off`、`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` | 通用配置给出全部档位：OpenAI 文档列出 `none`…`max`（各模型支持的子集不同）；`off` 用于 DeepSeek、方舟等支持 `thinking.type` 的兼容服务 |
| OpenAI Responses 自定义 | 同上 | 同上 |
| Anthropic 自定义 | `off`、`low`、`medium`、`high`、`xhigh`、`max` | Anthropic 文档：`output_config.effort` 取 `low`…`max`；`thinking: {"type": "disabled"}` 关闭思考（部分模型不接受，如 Claude Sonnet 5.5、Opus 5.5 会返回 400） |
| DeepSeek | `off`、`low`、`high`、`max` | DeepSeek 文档：`reasoning_effort` 取 `low`/`high`/`max`，默认开启思考、默认 `high`；`thinking: {"type": "disabled"}` 关闭 |
| 火山 Coding Plan / Agent Plan（Responses） | 按模型而定，见下表；模型不在表中时为 `low`、`medium`、`high` | 火山 Codex 接入文档：`model_reasoning_effort` 可设 `low`、`medium`、`high`；各模型的实际差异见火山方舟深度思考文档 |
| 火山 Coding Plan / Agent Plan（Anthropic） | 无（只有"默认"） | 火山官方文档未说明 Anthropic 接口的思考参数 |

- 火山各模型的思考档位（依据火山方舟深度思考文档的 `reasoning_effort` 映射表与 `thinking.type` 支持表，2026-11-08 核对）。只列出映射后效果不同的档位；`off` 即 `thinking: {"type": "disabled"}`：

| 模型 | 可选档位 | 模型默认 | 说明 |
|---|---|---|---|
| `doubao-seed-2.1-pro`、`doubao-seed-2.1-lite`、`doubao-seed-evolving` | `off`、`low`、`medium`、`high` | `high` | `xhigh`/`max` 会被映射为 `high` |
| `doubao-seed-2.0-mini` | `off`、`low`、`medium`、`high` | `medium` | 同上 |
| `deepseek-v4.1-flash`、`deepseek-v4.1-flash-economy` | `off`、`low`、`high`、`max` | `high` | `medium`/`xhigh` 映射为 `high` |
| `deepseek-v4-pro`、`deepseek-v4-flash` | `off`、`low`、`high`、`max` | `high` | `medium` 映射为 `low`，`xhigh` 映射为 `high` |
| `glm-5.3-flash` | `low`、`high`、`max` | `max` | 不能关闭思考；`medium` 映射为 `high` |
| `kimi-k3.1-pro` | `low`、`high`、`max` | `max` | 始终开启思考，不使用 `thinking` 参数；`medium` 映射为 `low` |
| `glm-5.3`、`kimi-k3`、`kimi-k2.8-preview`、`ark-code-latest` 及其他 | `low`、`medium`、`high` | — | 深度思考文档未列出这些模型，按 Codex 接入文档的通用档位；`glm-5.3`、`kimi-k3` 不能关闭思考，因此不提供 `off` |

- 上表来自方舟通用推理接口（`/api/v3`）的文档，按模型名对应到套餐中的同名模型；套餐接口上的实际行为须用真实 key 实测。
- 模型不支持所选档位时，服务端会返回 400 或自行映射到相近档位；400 时提示用户在 bot 设置里改档位。
- 已知风险：DeepSeek 文档要求带 `tools` 的请求必须完整回传历史中的 `reasoning_content`，否则返回 400。线程中途从别的模型切换到 DeepSeek 时，历史里没有它的 `reasoning_content`，实现时须用真实 key 实测这种情况。
- 来源：OpenAI https://developers.openai.com/api/docs/guides/reasoning ；Anthropic https://platform.claude.com/docs/en/build-with-claude/effort 、https://platform.claude.com/docs/en/build-with-claude/thinking ；DeepSeek https://api-docs.deepseek.com/guides/thinking_mode ；火山 https://docs.volcengine.com/docs/ark/agent-plan-personal-codex?lang=zh 、https://docs.volcengine.com/docs/82379/1449737 （2026-11-08 核对）。

### 5.2 中性消息结构

- `messages` 表不存任何一家 API 的原始 JSON，而用 minibot 自己的中性结构：内容块 `text`、`reasoning`、`tool_use`、`tool_result`。每次请求由对应格式的适配器把中性历史翻译成目标格式，因此线程中途换模型 / 换格式可以继续。
- 只能原样回传给同一家的数据（Anthropic thinking 的 `signature`、Responses 的加密 reasoning 等）放在块的不透明字段里，并标记来源格式 + 模型；适配器只在格式和模型都一致时回传，否则丢弃该推理块，不转成普通文本。
- 工具调用 ID 由 minibot 自己生成（只含 `[A-Za-z0-9_-]`），各家格式都合法。
- Responses 按无状态方式使用：每次发送完整历史，`store: false`，不依赖 `previous_response_id`。
- 消息可带 `kind` 标记（里程碑 2 的 `delegation_result`，见 8.2）；`kind` 不改变内容块类型。

### 5.3 API Key

- 存放于 `secrets.bin`，用 Electron `safeStorage` 加密。
- Linux 无可用密钥库时：以 `safeStorage.getSelectedStorageBackend() === 'basic_text'` 判定（不用已弃用的 `isEncryptionAvailable()`，Linux 无密钥库时它会用硬编码口令"加密"）。此时**不保存 key**，弹窗提示安装 `gnome-keyring` 或 `kwallet`；同时支持从环境变量读取 key（不落盘），给无桌面环境的机器留一条路。绝不退回明文，也不做主口令。
- **Key 脱敏**：内核在内存里维护已知 Key 值的集合（只收长度 ≥ 8 的非空 Key），并提供统一的纯函数 `redactSecrets(text)`，把命中的 Key 替换为 `[REDACTED_API_KEY]`。在**工具结果（`tool_result`）生成的出口**统一过一遍，因此即使模型用 `run_command` 打印了环境变量、或读了含 Key 的文件，Key 也在写入 SQLite、经 WebSocket 推给界面、发给远端模型之前就被抹掉。同一个函数还用在：日志写入前；模型生成的文本落库前。用户输入的消息保持原样不改。局限：只能识别已知 Key 的原文，变形（如分段、编码后）的无法识别。
- **写入时的 Key 规则**（读取结果已脱敏，写入不能再静默替换，否则会损坏文件）：
  1. **防占位符回写**：`write_file` 的内容、`edit_file` 的 `old_string` / `new_string` 只要含字面量 `[REDACTED_API_KEY]`，直接报错拒绝，提示模型"包含已脱敏占位符，禁止写回；请用 `edit_file` 只修改不含密钥的行"。否则模型读了 `.env` 再整篇覆写，真 Key 会被占位符永久替换。边界：文件本身就含这个字面量（如讨论本机制的文档）时会误拒，可接受。
  2. **记忆与画像不得含真 Key**：写入目标是 `user.md` 或任一 `memory/` 目录时，内容命中已知 Key 集合即报错拒绝，不静默替换。
  3. **普通文件不改写入内容**：工作目录内的其他文件按模型给出的内容原样写入（照常走审批），保证用户让 bot 生成或修改配置文件时所见即所得。

## 6. Bot 与线程

### 6.1 Bot

- 多个 bot；每个 bot 独立：设定、模型配置（供应商 + 模型名）、记忆、工作目录、审批模式。
- 初始化时创建的 bot 即主 bot。

### 6.2 线程

- 每个 bot 可开多个线程：共享该 bot 的记忆，可同时运行。
- **每个线程一个严格串行的执行队列**：用户消息、委托结果（里程碑 2）等都作为一轮入队，同一线程同一时刻只跑一个 agent 循环。
- 线程与消息存 SQLite，支持分页加载、按线程查询、压缩后保留原文。

### 6.3 停止（Abort）

- 界面经 WebSocket 发送中断，内核：`AbortController.abort()` 切断模型请求；结束正在执行的 `run_command` 进程树；已流式输出的部分回复照常保存并标记为中断。
- 每个未完成的工具调用都补一条状态为 `cancelled` 的工具结果写入 SQLite，保证三种格式的历史都合法（Anthropic `tool_use` 必须有对应 `tool_result`；OpenAI 每个 `tool_call` 必须有对应的 tool 消息）。

### 6.4 压缩

- 接近上下文上限时自动压缩，也可手动压缩；压缩后原文仍在 SQLite 可查。
- 完整摘要压缩只在一轮结束后（无未完成工具调用）、下一轮开始前进行，用当前 bot 的模型生成摘要。
- 一轮内部（连续工具调用）上下文吃紧时，先把较早的大块工具结果就地替换为 `[已省略历史工具输出]`（原文仍在 SQLite）；若裁剪后仍放不下，才在这一轮中途做摘要。
- 压缩前提取记忆不阻塞对话：记忆提取在压缩完成后于后台进行。

## 7. 本地操控

只有文件读写 + 执行命令。路径默认相对 bot 工作目录。

### 7.1 工具

| 工具 | 作用 | 限制 / 实现 |
|---|---|---|
| `read_file` | 读文件，支持起始行 + 行数 | 每次最多 2000 行；单行超 2000 字符截断；拒绝二进制 |
| `write_file` | 新建或整体覆盖 | 覆盖已存在文件前必须在本线程读过，且读后未被改动 |
| `edit_file` | 精确字符串替换 | 旧文本须唯一匹配，否则报错；可选全部替换；读后未被改动 |
| `glob` | 按模式找文件；不递归的模式（如 `*`）即列目录 | `fs.promises.glob`（Node 24 稳定）+ `exclude` 跳过 `.git`、`node_modules`；最多 500 个结果 |
| `grep` | 正则搜索内容 | `@vscode/ripgrep` 自带的 rg 子进程（尊重 `.gitignore`、跳过二进制，不阻塞主进程），复用 `run_command` 的进程管理；最多 200 条匹配 |
| `run_command` | 执行命令 | 见 7.4 |

不设记忆专用工具，记忆直接用 `read_file` / `edit_file` / `write_file`（见 9）。

### 7.2 路径校验

- 所有文件工具先解析真实路径，再判断是否位于工作目录内：已存在的路径用 `fs.realpath`；尚不存在的路径（新建文件）对最近的已存在父目录做 `realpath` 后拼接剩余部分。
- 由此拦截 `../` 越界与软链接 / Windows junction 逃逸；Windows 下前缀比较不区分大小写。
- 内置敏感路径名单（至少 `~/.minibot/secrets.bin`、`~/.minibot/config.json`、`~/.ssh`），**任何模式下**文件工具读写都要弹审批。
- **边界说明**：路径校验只约束文件工具。`run_command` 能做任何当前用户能做的事，"全自动"模式下命令本身就是真正的权限边界，文档和设置界面必须向用户说明。

### 7.3 统一乐观锁

- 每个线程在内存里记录 `文件路径 → 读取时的内容哈希`。`write_file` / `edit_file` 写入前比对：文件在读取后被改动（别的 bot、别的线程、用户在编辑器里）就报错，要求重新读；覆盖已存在且从未读过的文件同样报错。
- 适用于所有文件，记忆不另设规则；应用重启后记录清空，需重新读取再写。
- "比对 + 写入"在内核内按路径加瞬时互斥，保证原子。不用文件锁：模型从读到写可能间隔数分钟，长期持锁会阻塞其他线程。
- 局限：`run_command` 对文件的改动无法拦截，但会使已读文件的哈希失配，之后文件工具写入同样会被要求重读。

### 7.4 命令执行

- **Shell**：Windows 优先 `pwsh`，没有则 `powershell.exe`；Linux 用 `bash`；工作目录为 bot 工作目录。
- **超时**：默认 120 秒，模型可指定，最长 600 秒；超时结束整个进程树。
- **输出**：stdout + stderr 按时间顺序合并；超过 30,000 字符时保留开头 15,000 + 结尾 15,000，中间注明省略量；完整输出存到 `~/.minibot/outputs/` 并把路径告诉模型。
- **返回**：退出码、是否超时、耗时、输出。
- 第一版不做后台常驻命令。
- **Windows 编码**：以 `-NoProfile -NonInteractive -EncodedCommand` 启动 PowerShell（Base64 UTF-16LE 传命令，避开引号转义和代码页问题），命令前置设置 `[Console]::OutputEncoding`、`[Console]::InputEncoding`、`$OutputEncoding` 为无 BOM 的 UTF-8。输出不是合法 UTF-8 时，按系统 ANSI 代码页（如 GBK）回退解码（`TextDecoder` 在 Electron 中对 `gbk` 的支持，实现时核实）。
- **进程终止**：Linux `spawn` 用 `detached: true` 建独立进程组，超时 / 停止时先 `SIGTERM` 整个进程组，宽限约 2 秒后 `SIGKILL`；Windows 不设 `detached`，用 `taskkill /T /F`。
- **管道不关**：主进程退出后孙进程仍占着输出管道时，`close` 事件可能不来：以 `exit` 为准，短暂等待后主动销毁输出流并返回结果。

## 8. 审批与委托

### 8.1 审批（每个 bot 单独设置）

- 两种模式：**每次问我**（新 bot 默认）/ **全自动**。"问我"时对话中弹出批准/拒绝卡片，拒绝以工具错误返回给模型。
- "问我"模式下：工作目录内的只读操作（`read_file` / `glob` / `grep`）不审批；写文件、执行命令、访问工作目录外的路径需审批。
- **记忆白名单**：`~/.minibot/user.md` 与本 bot 的 `~/.minibot/bots/<本 bot>/memory/` 在任何模式下读写都免审批；其他 bot 的 `~/.minibot/bots/<其他 bot>/` 视同工作目录外路径，需审批。
- 敏感路径名单任何模式都审批（见 7.2）。
- 审批只在内核里实现一处，所有模型格式行为一致。
- 审批卡片带 bot 与线程标识，多个线程的请求由前端排队展示。

### 8.2 委托与群聊（里程碑 2）

- **四种形态**：等结果的同步委托、异步发消息、群聊、主 bot 分派。
- **同步委托**：结果是正常的 `tool_result`。沿链传递 `call_stack: [bot_id]`，出现环路直接拒绝并报错；深度上限 3 层；设超时（时长实现时定），被委托方超时未完成，发起方收到超时结果并继续；审批等待不计入超时。被委托方弹出的审批卡片同时显示在发起方当前线程里，可直接批准或拒绝。
- **异步委托结果**：
  - 原线程出现**委托结果卡片**：来自哪个 bot、任务标题、状态（完成/失败）、用时、结果正文（长则折叠）、"查看过程"链接（打开被委托方线程）。
  - 卡片同时进入发起方 bot 的上下文，发起方自动接着处理。
  - 原线程正在回复时，卡片等本次回复结束后再入队，不打断对话（走 6.2 的线程队列）。
  - 存储：不新增内容块类型，也不用 `tool_result`（异步发起那次工具调用已返回 `dispatched`，事后单独插入的 `tool_result` 会被三家 API 拒绝）。存为一条普通 `role: 'user'` 消息，带 `kind: 'delegation_result'`，正文为固定格式的结果文本；界面按 `kind` 渲染成卡片。
- **群聊规则**：@ 谁谁答（@everyone 全员答）；无 @ 即视为 @主 bot，不另做分派状态机；主 bot 默认在每个群里；bot 间连续接力有轮数上限（如 10 轮），超过后停下等用户。
  - 主 bot 用委托工具点名其他 bot，被点名 bot 的回复作为群消息（带 `sender_bot_id`）写入当前群线程，群成员和主 bot 都能看到，主 bot 再决定继续接力或汇总。

## 9. 记忆

- **用户画像** `~/.minibot/user.md`：只有一份，所有 bot 共享。
- **主题记忆** `~/.minibot/bots/<bot-id>/memory/<主题>.md`：每个 bot 独立，每个主题一份。提示词里只放主题名 + 简介，需要时读全文。
- **文件头约定**：`<主题>.md` 的**第一行必须**是 `> 简介：<一句话简介>`，其余为正文。主题名取文件名（去掉 `.md`）。选这种写法而不用 YAML frontmatter，是为了让内核只读每个文件的第一行就能拼出目录，不需要解析器。
- 解析：先切出第一行（按 `\n` 切），再用 `^\uFEFF?>\s*简介\s*[:：]\s*(.+?)\r?$` 匹配，捕获结果 `trim()`。兼容 BOM、全半角冒号、冒号前后空格与 CRLF。
- 内核组装系统提示词时只读第一行；第一行缺失或不符合约定（含简介为空）的文件，目录里只列主题名并标注"无简介"，不报错、不阻塞对话，由后台整理补上。
- 系统提示词里要告诉 bot 这条约定（新建主题文件必须先写这一行）；后台整理的提示词同样遵守并负责修复不合规的文件头。
- 记忆与画像为本地 Markdown 文件，用户可直接用编辑器修改。
- **写入途径**：bot 对话中自己写；用户说"记住"时写；后台整理；用户在界面中查看/编辑。
- **读写方式**：用 `read_file` / `edit_file` / `write_file`（白名单见 8.1，并发由 7.3 乐观锁处理）。

### 9.1 修改历史

- 存 `minibot.db` 的 `memory_revisions` 表，字段：`id, file_path, actor, source, created_at, before_content, after_content, after_hash`。前后全文都存（文件只有几 KB，快照比 diff 回滚简单）。磁盘上只保留最新版 `.md`。
- `actor`：`bot_id` 或 `'user'`；唯一例外是 `source = 'external'` 时为 `null`（未知）——外部修改可能来自用户的编辑器、bot 的 `run_command` 或其他程序，内核无法分辨，不能记成用户。
- `source` 取值：`chat`（bot 在对话中写，actor 为该 bot）、`consolidation`（后台整理，actor 为该 bot）、`manual_ui`（用户在界面编辑，actor 为 `user`）、`revert`（撤销，actor 为 `user`）、`external`（外部修改，actor 为 `null`）。界面据此标出"后台整理""外部修改"等标签。
- 所有对 `user.md` 与记忆目录的写入（工具写入、后台整理、界面编辑、撤销）都记一条修订；用户可在界面查看和撤销。
- **统一写入流程**（以上四种写入共用）：
  1. 计算磁盘当前内容的哈希 `current_hash`。
  2. 若该文件已有修订且 `current_hash !== 最近一条修订的 after_hash`，说明期间被外部改过：先补记一条 `external` 修订（`before_content` = 最近一条修订的 `after_content`，`after_content` = 当前磁盘内容）。
  3. 若该文件还没有任何修订，以当前磁盘内容作为本次的 `before_content`。
  4. 写入，并记本次修订（含 `after_content`、`after_hash`）。
- 撤销 = 把目标修订的 `before_content` 写回，按上面流程记一条 `revert` 修订，历史只增不删。
- **界面编辑也受乐观锁约束**：界面保存时携带打开时的内容哈希，与磁盘不一致即提示冲突、不覆盖，避免用户编辑期间 bot 的写入被整篇覆盖。

### 9.2 后台整理

- 时机：线程空闲后 + 压缩对话时。
- 每个线程记录 `last_extracted_msg_id`；一个全局定时器每隔几分钟扫描 `threads` 表，找出"空闲超过阈值且有未整理消息"的线程做增量整理；压缩时同样只整理 `last_extracted_msg_id` 之后的增量。不为每个线程单独挂定时器。
- 整理时合并重复条目，并淘汰过时信息：新事实与旧记录冲突时（如用户换了技术栈、改了偏好），直接更新覆盖旧条目，而不是并列追加。`memory_revisions` 保留每次修改前的全文快照，覆盖可随时撤销，因此当前 `.md` 应始终保持精炼、无自相矛盾的过期内容。
- 整理结果要保持文件头合规（见第 9 节），简介随正文变化同步更新。
- **执行方式**：不走带工具的 agent 循环，也不触发审批。内核读取相关记忆文件 → 把文件内容与增量消息交给模型 → 模型返回新内容 → 内核写入。每次整理创建独立的执行上下文，持有自己的"已读哈希"表（同 7.3），调用同一套文件读写函数、同一把路径级互斥；写回前哈希不一致（前台 bot 或用户刚改过）就放弃该文件本次修改，留到下个扫描周期，绝不覆盖前台改动。写入按 9.1 记 `consolidation` 修订。
- **群聊（里程碑 2）**：群聊线程的后台整理只更新 `user.md` 与主 bot 的 `memory/`，不跨其他 bot 的目录。子 bot 若认为群里的某件事对自己重要，在自己发言的那一轮里用 `edit_file` 写进自己的 `memory/`（免审批）。副作用：子 bot 在群里写的记忆，只有在该子 bot 自己的线程被整理时才会去重合并，可接受。
- 模型：默认复用该线程所属 bot 自己的模型配置（群聊线程用主 bot 的模型配置），零额外配置。设置里提供一个可选项"后台整理专用模型"（供应商 + 模型名），填写后所有后台整理改用它；留空即用默认。

## 10. 首次启动

单卡片步骤流程（吉祥物形象 + 过渡动画），依次：
1. 模型接入（必填）
2. 用户画像（可跳过）
3. 主 bot 设定（可跳过，为空时随机生成）
4. 主 bot 工作目录（可跳过，为空时用默认目录 `~/.minibot/workspaces/<bot-id>/`）

完成后生成主 bot，进入与它的对话。具体视觉与动画属于界面设计，另行设计。

## 11. 数据目录

```
~/.minibot/
├─ config.json          # 全局设置、供应商列表（不含 key）
├─ secrets.bin          # 加密后的 API key（safeStorage）
├─ user.md              # 用户画像（所有 bot 共享）
├─ minibot.db           # 线程与消息、memory_revisions（SQLite，WAL）
├─ bots/<bot-id>/
│  ├─ bot.json          # 名字、设定、供应商 + 模型名、工作目录、审批模式
│  └─ memory/<主题>.md
├─ workspaces/<bot-id>/ # 未指定工作目录时的默认工作目录
└─ outputs/             # 被截断命令的完整输出
```

- 选 SQLite 的理由：多线程并发写入、分页加载、按线程查询、压缩后保留原文、日后手机端翻历史。
- `config.json`、`bot.json` 写入采用"写临时文件再改名"保证原子性，并带 `schemaVersion`，格式变化走迁移函数。
- 统一用一个 `atomicWriteFile` 函数完成。Windows 下目标文件若恰被杀毒软件或文件索引器短暂打开，`rename` 会偶发抛 `EPERM` / `EACCES`，因此对 `rename` 在 `EPERM` / `EACCES` / `EBUSY` 时重试，间隔从 20ms 起逐步加到约 100ms，总时长约 2 秒，仍失败再向上报错（参考 `graceful-fs` 的做法）。目标文件被我们自己的其他读取打开时同样会触发 `EPERM`，所以重试对内部并发也有用。

## 12. 留给实现者决定的部分

- 包管理器、测试框架、模块划分。
- HTTP/WS 的具体路由与事件类型定义。
- 压缩摘要的提示词与保留轮数、触发阈值。
- 同步委托超时时长；记忆条目的大小上限（若需要）；后台整理的扫描间隔与空闲阈值。
- 测试用假模型（不发真实请求）覆盖：agent 循环、两种审批模式与白名单、路径越界（含 `../`、软链接、junction、新建文件）、敏感路径、乐观锁拒绝过期写入、中断后历史合法（`cancelled` 工具结果）、三种格式适配器往返与中途换格式、压缩时机、`run_command` 超时与进程树清理、记忆修订与撤销（含外部修改补记、界面编辑冲突）、后台整理哈希失配时跳过、主题目录生成（含 BOM、CRLF、全半角冒号、文件头缺失或不合规）、写入含占位符被拒、记忆写入含真 Key 被拒、本机接口鉴权（`Host`/`Origin`/令牌）、key 脱敏；里程碑 2 另加委托环路与深度限制、异步结果卡片入队、群聊接力上限。

## 13. 参考

- 底座思路：HKUDS/nanobot（早期约 4000 行：agent 循环、Markdown 记忆、技能列表按需加载）：https://github.com/HKUDS/nanobot
- 产品形态：OpenMausBot（多 bot、委托、群聊、初始化卡片、内核与界面分离）：https://github.com/milind-soni/OpenMausBot ；审批档位：https://github.com/CoeusInstitute/openmausbot/blob/main/docs/approval-levels.md
- 同类：CopilotKit/OpenBot（https://github.com/CopilotKit/openbot）、Grok Bot（xAI）。
- Grok Bot 架构（非官方课程）：https://github.com/yuanyijie/learn-grok-bot
- Hermes 记忆：https://hermes-agent.nousresearch.com/docs/user-guide/features/memory

