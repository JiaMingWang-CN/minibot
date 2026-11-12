# 远程控制（二）：安卓 App 实现计划

> **For agentic workers:** Implement this plan task-by-task, in order. Each task's requirements include the Global Constraints below; each task's Interfaces block tells you the names and types neighboring tasks use. The plan gives approach and constraints only — you write the tests and the code. Steps use checkbox (`- [ ]`) syntax for tracking — tick each one as it is done.

**Goal：** 做出自用安卓 APK：扫码配对电脑后，经局域网直连或自建中继，在手机上选 bot、聊天（含图片）、中断、审批、翻历史、管理对话，并在后台收到审批与完成通知。

**Architecture：** `apps/mobile` 是手机界面的 Vite + React 工程，通过路径别名直接复用 `apps/renderer/src` 的样式 token、`ui/`、`i18n.ts`、`useConversation`、`Transcript`、`Composer`、`ApprovalCard`、`useComposerImages`。`apps/renderer/src/api.ts` 改为依赖注入的"传输"，桌面用本机 HTTP/WS，手机用原生桥接。`apps/mobile/android` 是 Capacitor 生成的原生工程，唯一的原生逻辑是一个 Kotlin 前台服务：持有到电脑的 Noise 加密连接（先局域网后中继）、发通知，并经 Capacitor 插件与网页交换明文 JSON。

**Tech Stack：** React 19、Tailwind v4、Vite 8.3.5、Capacitor（`@capacitor/core` / `@capacitor/android` / `@capacitor/cli` 同一大版本）、Kotlin、`kotlinx-coroutines-android`、OkHttp 4.12.0（WebSocket）、BouncyCastle `bcprov-jdk18on` 1.80（X25519、ChaCha20-Poly1305）、`zxing-android-embedded` 4.3.0（扫码）、JUnit。

**Spec：** `docs/specs/2026-11-11-android-remote-design.md`（以下简称"设计"），覆盖第 6.6 节、第 7 节手机侧与第 8 节安卓部分。依赖计划一 `docs/plans/2026-11-11-remote-pc-relay.md` 已完成：协议、帧格式、中继协议、应用层消息、白名单都以计划一为准，本计划不重新定义。

## Global Constraints

- 前置：计划一全部任务已完成并通过。
- 协议常量与计划一一致：Noise 协议名 `Noise_XXpsk3_25519_ChaChaPoly_SHA256` / `Noise_KK_25519_ChaChaPoly_SHA256`，prologue `minibot-remote/1`，帧类型 `0x01` / `0x02` / `0x03`，分块数据上限 `65518` 字节，拼接上限 `37748736` 字节，中继路径 `/v1`，配对码前缀 `minibot-pair:`。
- 握手帧格式以计划一 Task 5 为准：配对三条消息都是 `[0x01][Noise 消息]`；日常连接首帧 `[0x02][16 字节 deviceId][msg1]`，电脑回 `[0x02][msg2]`。电脑回完最后一条握手消息后会立刻发 `ready`，两帧可能同时到达：承载换处理函数（握手 → 加密信道）时必须缓冲，不能丢帧。
- 中继协议里手机一侧不变（`hello` 只带 `role: "phone"`、`routeId`、`token`）；电脑一侧的身份证明（`challenge` / `proof`）与手机无关。
- 所有 npm 与 Gradle 依赖锁定精确版本；Capacitor 取实现时的最新稳定大版本，三个包版本完全一致。不引入 Google Play 服务、Firebase、ML Kit 或任何第三方推送。
- `minSdk 26`、`targetSdk 35`；Kotlin 与 JDK 版本按所选 Capacitor 大版本的要求。
- 手机端不复制粘贴桌面端文件，只通过 import 复用；复用不了的才在 `apps/mobile` 新写。
- 界面文案只有简体中文，新增文案加在 `apps/renderer/src/i18n.ts`（键名以 `mobile.` 开头）；颜色只用 `styles.css` 的语义 token 工具类，控件复用 `recipes.ts`（`.claude/CLAUDE.md`）。Kotlin 里的通知文案同样只写中文，集中在 `res/values/strings.xml`。
- 原生层永远不把密钥交给网页层：私钥、psk 与中继口令只在 Kotlin 层保存与使用。扫码配对全程在原生完成；只有用户手动粘贴的配对码会经网页传给原生一次，网页不保存它。
- 通知里不放"批准"按钮；锁屏可见内容不含命令原文。
- 签名 keystore 不入库，路径与口令由环境变量 `MINIBOT_KEYSTORE`、`MINIBOT_KEYSTORE_PASSWORD`、`MINIBOT_KEY_ALIAS`、`MINIBOT_KEY_PASSWORD` 提供。
- 构建手机端需要 Android SDK 与 JDK；CI 不跑安卓构建，只在本地 / 手动执行。

## Review Focus

1. 一次选 4 张大图（合计约 27 MB base64）从手机发出 → 正常送达，网页层不卡死、不因桥接超时失败（Task 4、Task 5）。
2. 手机从 Wi-Fi 切到移动数据，或电脑休眠后唤醒 → 自动重连，界面状态先显示"正在重连 / 电脑离线"再恢复，重连后对话内容补齐（Task 3、Task 5）。
3. App 被系统杀掉后点开审批通知 → 冷启动直接进入对应对话并能看到审批卡片（Task 4、Task 5）。
4. 电脑端撤销了这台手机 → 手机不无限重连刷屏，显示"已被电脑撤销，请重新配对"并回到配对页（Task 3、Task 5）。
5. 手机端对白名单外接口的调用（如 `useConversation` 里取上下文用量）→ 不弹错误提示、不影响其余功能（Task 1）。

---

### Task 1：`api.ts` 传输抽象（桌面回归）

**Files:**
- Modify: `apps/renderer/src/api.ts`、`apps/renderer/src/App.tsx`、`apps/renderer/src/main/useConversation.ts`

**Interfaces:**
- Produces:
  - `interface TransportResponse { status: number; json?: unknown; bytes?: Uint8Array; contentType?: string }`
  - `interface Transport { request(method: string, path: string, body?: unknown): Promise<TransportResponse> }`
  - `localTransport(conn: Conn): Transport`
  - `createApi(transport: Transport): Api`（返回对象的方法名与签名不变）
  - `EventConnection`、`ClientMessage` 保持不变；`connectEvents(conn, onEvent)` 保持不变（桌面专用）
  - `useConversation` 新增可选参数 `withContext?: boolean`（默认 `true`）

**思路:**
- `createApi` 内的 `request` / `call` 改为调 `transport.request`；非 2xx 时从 `json.error` 取 `code` / `message` 抛 `ApiError`，规则与现在一致。`attachmentUrl` 用 `bytes` + `contentType` 造 `Blob` 再 `URL.createObjectURL`。
- `localTransport` 承接现在的 `fetch` 逻辑：JSON 响应解析成 `json`，非 JSON（附件）读成 `bytes`。
- `withContext` 为 `false` 时，`useConversation` 不调用 `api.context`（该接口不在远程白名单内）。

**约束:**
- 桌面端行为与网络请求完全不变。

**验收（手动）：**
- `npm run build && npm run lint` 通过。
- 桌面端启动后：切换对话、发消息（含图片）、看附件缩略图、审批、上下文圆环、重连后补齐都与改动前一致。

- [ ] **Step 1:** 按 **思路** 与 **约束** 实现。
- [ ] **Step 2:** 运行 `npm run build && npm run lint` — PASS。
- [ ] **Step 3:** 按 **验收** 手动检查。
- [ ] **Step 4:** 提交。

### Task 2：跨语言互通夹具

**Files:**
- Create: `packages/core/test/fixtures/remote-interop.json`、`packages/core/test/remote-interop.test.ts`

**Interfaces:**
- Consumes: 计划一的 `createHandshake`、`SecureChannel`、帧类型常量
- Produces: 夹具 JSON 结构：`{ pairing: { pc: {s, e}, phone: {s, e}, psk, pcPayload, phonePayload, frames: string[] }, kk: { pc: {s, e}, phone: {s, e}, deviceId, frames: string[] }, channel: { messages: unknown[], frames: string[] } }`（键与帧均为 hex；`frames` 是线上完整帧，含帧类型字节；`channel` 用 `kk` 握手后的密钥，含一条跨 3 个分块的长消息）

**思路:**
- 测试里以固定密钥（含固定临时密钥）跑一遍配对握手、KK 握手、信道收发，与夹具逐帧比对；带环境变量 `UPDATE_FIXTURES=1` 运行时改为重写夹具。Kotlin 端（Task 3）读同一个文件做同样的比对。

**约束:**
- 夹具只含测试用密钥，不得使用任何真实设备密钥。

**验收:**
- `interop 夹具一致`：当前 TS 实现生成的全部帧与夹具逐字节相同。

- [ ] **Step 1:** 写测试并用 `UPDATE_FIXTURES=1 npm test` 生成夹具，再运行 `npm test` — PASS。
- [ ] **Step 2:** 提交。

### Task 3：安卓工程骨架、Kotlin 协议与连接管理

**Files:**
- Create: `apps/mobile/package.json`（`@minibot/mobile`）、`apps/mobile/capacitor.config.ts`（`appId: "app.minibot.mobile"`、`appName: "minibot"`、`webDir: "dist"`）、`apps/mobile/android/`（`npx cap add android` 生成）
- Create（Kotlin 包 `app.minibot.mobile.remote`）：`Noise.kt`、`SecureChannel.kt`、`PairingStore.kt`、`RelayCarrier.kt`、`LanCarrier.kt`、`Connector.kt`
- Modify: `apps/mobile/android/app/build.gradle`（依赖、测试资源目录指向 `packages/core/test/fixtures`）、根 `package.json`（workspaces 加 `apps/mobile`）
- Test: `apps/mobile/android/app/src/test/java/app/minibot/mobile/remote/` 下 `NoiseTest.kt`、`SecureChannelTest.kt`、`ConnectorTest.kt`

**Interfaces:**
- Produces（Kotlin）：
  - `interface Carrier { fun send(frame: ByteArray); var onFrame: (ByteArray) -> Unit; var onClose: (reason: CloseReason) -> Unit; fun close() }`
  - `sealed class CloseReason`：`Normal`、`PcOffline`、`Rejected`（握手被拒 / 设备已撤销）、`Network(message: String)`
  - `data class Pairing(val pcName: String, val pcPublicKey: ByteArray, val routeId: String, val relayUrl: String?, val relayToken: String?, val lanAddresses: List<String>, val lanPort: Int, val deviceId: String)`
  - `class PairingStore(context: Context) { fun load(): Pairing?; fun identity(): KeyPair; fun save(p: Pairing); fun clear() }`
  - `fun parsePairingCode(code: String): PairingOffer`（解析 `minibot-pair:` 码，含 psk）
  - `class Connector(scope: CoroutineScope, store: PairingStore, carriers: CarrierFactory) { val state: StateFlow<ConnectionState>; fun start(); fun stop(); suspend fun pair(offer: PairingOffer, deviceName: String); fun send(message: JSONObject); var onMessage: (JSONObject) -> Unit }`
  - `sealed class ConnectionState`：`Idle`、`Connecting`、`Connected(via: Via, pcName: String)`、`PcOffline`、`Revoked`、`Error(message: String)`；`enum class Via { LAN, RELAY }`

**思路:**
- `Noise.kt` / `SecureChannel.kt`：与计划一 TS 实现逐条对应，DH 与 AEAD 用 BouncyCastle 轻量 API（`X25519Agreement`、`ChaCha20Poly1305`），HKDF 用 HMAC-SHA256 手算。
- `PairingStore`：手机长期 X25519 私钥与 `Pairing`（含 psk 以外的全部字段）存在应用私有文件里，整体用 Android Keystore 里一把 AES-GCM 密钥加密；该密钥不要求用户验证（设计：不加应用锁、后台需自动重连）。
- `LanCarrier`：OkHttp WebSocket 连 `ws://<地址>:<lanPort>/v1`。`RelayCarrier`：连 `relayUrl` 并发 `hello`（`role: "phone"`），处理 `welcome` / `pc_online` / `pc_offline`，二进制帧原样收发。
- `Connector.start()`：对所有局域网地址并发尝试连接 + KK 握手，`1500` ms 内谁先完成用谁；都失败再走中继。中继收到 `pc_offline` → 状态 `PcOffline` 并等待 `pc_online` 后重新握手。其余断线按 1s 起翻倍、上限 60s 退避重试；系统网络变化回调触发立即重新选择。
- KK 握手在中继或局域网上被直接关闭且承载本身连通（中继已 `welcome` / 局域网已建立 WebSocket）→ 视为 `Revoked`，停止重连。
- `pair()`：用配对码里的信息走 `XXpsk3`（局域网优先、中继兜底，与上同），msg3 载荷 `{deviceName}`；收到 `paired` 后保存 `Pairing`，直接进入 `Connected`。

**约束:**
- 握手超时 `10000` ms；单条应用消息拼接上限 `37748736` 字节，超限关闭。
- 设备名默认 `Build.MODEL`，去首尾空白后 1–40 个字符。
- `Revoked` 后不自动重连，直到重新配对。

**验收:**
- `NoiseTest 官方向量`：读 `noise-vectors.json` 两种协议的全部用例 → 逐字节一致。
- `NoiseTest 互通`：读 `remote-interop.json`，以夹具里的固定密钥扮演手机，生成的帧与夹具一致，并能解开夹具中电脑侧的帧。
- `SecureChannelTest 大消息`：发 30 MB 消息 → 对端完整收到，每帧 ≤ `65536` 字节。
- `SecureChannelTest 篡改`：翻转一字节 → 关闭。
- `ConnectorTest 局域网优先`：假局域网承载 200 ms 内握手成功、假中继也可用 → 状态 `Connected(LAN)`，中继未被连接。
- `ConnectorTest 局域网超时`：假局域网 2000 ms 无响应 → 状态 `Connected(RELAY)`。
- `ConnectorTest 电脑离线`：中继回 `pc_offline` → 状态 `PcOffline`；随后 `pc_online` → `Connected(RELAY)`。
- `ConnectorTest 撤销`：承载连通但 KK 被关闭 → 状态 `Revoked`，之后 120 s 虚拟时间内无新连接尝试。
- `ConnectorTest 退避`：中继连续失败 → 第 1–7 次重试间隔为 1、2、4、8、16、32、60 秒。
- `parsePairingCode`：缺前缀或 JSON 损坏 → 抛错；合法码 → 字段全部正确。

- [ ] **Step 1:** `npm init` + `npx cap add android` 搭骨架；写 **验收** 测试；运行 `cd apps/mobile/android && ./gradlew testDebugUnitTest` — FAIL。
- [ ] **Step 2:** 按 **思路** 与 **约束** 实现。
- [ ] **Step 3:** 运行 `./gradlew testDebugUnitTest` — PASS。
- [ ] **Step 4:** 提交。

### Task 4：前台服务、通知与 Capacitor 插件

**Files:**
- Create（包 `app.minibot.mobile`）：`RemoteService.kt`、`Notifier.kt`、`MinibotRemotePlugin.kt`
- Modify: `AndroidManifest.xml`、`MainActivity.kt`（注册插件、处理通知点击）、`res/values/strings.xml`
- Create: `apps/mobile/src/native.ts`（插件的 TS 声明与 `registerPlugin`）
- Test: `apps/mobile/android/app/src/test/.../NotifierTest.kt`

**Interfaces:**
- Consumes: `Connector`、`ConnectionState`、`PairingStore`、`parsePairingCode`（Task 3）
- Produces（插件 `MinibotRemote`，TS 声明在 `native.ts`）：
  - `getStatus(): Promise<PhoneStatus>`，`PhoneStatus = { paired: boolean; deviceModel: string; pcName: string | null; connection: 'idle' | 'connecting' | 'lan' | 'relay' | 'pc_offline' | 'revoked' | 'error'; error: string | null; background: boolean; notificationsAllowed: boolean; batteryOptimized: boolean }`
  - `scanAndPair(o: { deviceName: string }): Promise<{ cancelled: boolean }>`（扫码与配对都在原生完成）、`pair(o: { code: string; deviceName: string }): Promise<void>`（粘贴配对码用）、`unpair(): Promise<void>`
  - `request(o: { method: string; path: string; body?: unknown }): Promise<{ status: number; body?: unknown; bytes?: string; contentType?: string }>`（`bytes` 为 base64）
  - `sendControl(o: { msg: unknown }): Promise<void>`
  - `setActiveThread(o: { threadId: string | null }): Promise<void>`
  - `startBackground() / stopBackground() / requestNotificationPermission() / openBatterySettings(): Promise<void>`
  - `takeLaunchThread(): Promise<{ threadId: string | null }>`
  - 事件：`kernelEvent` `{ event }`、`ready` `{ pcName }`、`status` `PhoneStatus`、`openThread` `{ threadId }`

**思路:**
- `RemoteService` 是 `foregroundServiceType="remoteMessaging"` 的前台服务，持有唯一的 `Connector`；常驻通知显示连接状态。已配对且 `background` 为真时随 App 启动与开机后首次打开 App 时启动（不做开机自启）。
- 插件只是 `RemoteService` 的薄壳：`request` 生成递增 id，发 `{t:'req'}`，按 id 等 `{t:'res'}`；`evt` → `kernelEvent`，`ready` → `ready`，状态变化 → `status`。
- `Notifier` 收到每个 `evt`：`approval_request` → 高优先级通知；`turn` 变为 `idle` → 普通通知。标题需要的 bot 名 / 对话标题在收到 `ready` 后取 `GET /api/state` 缓存 bot，对话标题按需取 `GET /api/threads/:id` 并缓存。网页可见且 `activeThread` 等于该线程时不发。
- 通知点击打开 `MainActivity` 并带 `threadId`；Activity 已在则发 `openThread` 事件，冷启动则存起来等网页调 `takeLaunchThread`。

**约束:**
- 三个通知渠道：`connection`（低重要性，常驻）、`approval`（高重要性）、`done`（默认重要性）；渠道名 `连接状态`、`审批请求`、`任务完成`。
- 审批通知标题 `<bot 名> 请求批准`，正文为 `summary`；锁屏可见版本（`publicVersion`）正文为 `打开 minibot 查看`。完成通知标题 `<bot 名> 已完成`，正文为对话标题。
- 常驻通知文案：`已连接 <电脑名> · 局域网` / `已连接 <电脑名> · 中继` / `电脑离线` / `正在重连` / `已被电脑撤销，请重新配对`。
- `request` 在未连接时立即以 `code: "offline"`、消息 `电脑未连接` 拒绝；已发出的请求在断线时同样拒绝；单请求超时 `60000` ms。
- 插件对网页只暴露上述方法；不提供读取私钥、psk、中继口令的方法。

**验收:**
- `NotifierTest 审批`：`approval_request` 事件 + 缓存的 bot 名 → 生成 `approval` 渠道通知，标题与公开版本正文符合约束。
- `NotifierTest 前台抑制`：网页可见且 `activeThread` 等于事件线程 → 不生成通知；不同线程 → 生成。
- `NotifierTest 完成`：同一线程 `turn running` → `idle` → 生成一条 `done` 通知；只有 `idle` 没有先前 `running` → 不生成。
- 真机手动：锁屏下电脑端触发审批 → 收到通知、锁屏不显示命令；点通知（App 已被划掉）→ 冷启动进入该对话。

- [ ] **Step 1:** 写 **验收** 中的单元测试；运行 `./gradlew testDebugUnitTest` — FAIL。
- [ ] **Step 2:** 按 **思路** 与 **约束** 实现。
- [ ] **Step 3:** 运行 `./gradlew testDebugUnitTest` — PASS；真机按手动项检查。
- [ ] **Step 4:** 提交。

### Task 5：手机界面

**Files:**
- Create: `apps/mobile/index.html`、`apps/mobile/vite.config.ts`（别名 `@renderer` → `../renderer/src`）、`apps/mobile/tsconfig.json`、`apps/mobile/src/main.tsx`、`apps/mobile/src/styles.css`（引入渲染端 `styles.css` 并用 `@source` 扫描 `../renderer/src`）、`apps/mobile/src/transport.ts`、`apps/mobile/src/MobileApp.tsx`、`apps/mobile/src/screens/PairScreen.tsx`、`ThreadListScreen.tsx`、`ConversationScreen.tsx`、`SettingsSheet.tsx`、`apps/mobile/src/ApprovalBar.tsx`
- Modify: `apps/renderer/src/i18n.ts`（`mobile.*` 文案）

**Interfaces:**
- Consumes: `Transport`、`createApi`、`EventConnection`、`useConversation({ …, withContext: false })`（Task 1）；`MinibotRemote` 插件（Task 4）；`Transcript`、`Composer`、`ApprovalCard`、`useComposerImages`、`ui/*`、`t`
- Produces: `nativeTransport(): Transport`、`nativeEvents(onEvent: (e: KernelEvent) => void): EventConnection`

**思路:**
- `nativeTransport` 把 `request` 转给插件，`bytes` 由 base64 转 `Uint8Array`；插件以 `offline` 拒绝时抛 `ApiError('offline', '电脑未连接')`。`nativeEvents` 订阅 `kernelEvent`，`ready` 触发 `onOpen` 监听者（复用桌面重连补齐逻辑），`send` 调 `sendControl`。
- `MobileApp`：未配对 → `PairScreen`；已配对 → 顶部状态条（连接方式 / 电脑离线 / 正在重连）+ 页面栈：`ThreadListScreen` ↔ `ConversationScreen`。Android 返回键回到上一页。`revoked` 时清空并回到 `PairScreen`，显示 `已被电脑撤销，请重新配对`。
- `PairScreen`：大按钮"扫码配对"（`scanAndPair`），设备名输入框（默认取 `getStatus().deviceModel`），失败显示原因；另有"粘贴配对码"入口，便于调试。
- `ThreadListScreen`：顶部左侧按钮打开 bot 抽屉切换 bot；列表项为对话标题、运行中标记、待审批标记、最后时间；右下角新建；长按弹 `Menu`：重命名（`Dialog`）/ 删除（确认 `Dialog`）。
- `ConversationScreen`：顶部返回 + 对话标题 + 菜单；中间 `Transcript`；审批卡片用 `ApprovalCard`；底部 `Composer`（运行中显示停止，支持系统相册选图，复用 `useComposerImages`）。进入 / 离开时调 `setActiveThread`。
- `ApprovalBar`：任意页面顶部，有待审批时显示 `N 个待审批`，点击跳到最早一条所在对话。
- `SettingsSheet`（顶部状态条点开）：电脑名与连接方式、通知权限状态与请求按钮、电池优化状态与"去设置"、"停止后台连接" / "开启后台连接"、"取消配对"（确认后 `unpair`）。
- 首次配对成功后依次引导：通知权限 → 电池优化白名单。
- 冷启动时调 `takeLaunchThread`，并订阅 `openThread`，有值就进入该对话。

**约束:**
- 适配 360–430 px 宽、安全区（刘海 / 手势条）与软键盘弹出时 `Composer` 不被遮挡。
- 不出现任何改配置的入口（模型、审批模式、命令白名单、记忆、供应商、上下文压缩、bot 设置）。
- 颜色 / 深浅色完全跟随 `styles.css` 的 token 与系统深色模式。

**验收（手动，真机 + 计划一的电脑端）：**
- `npm run build --workspace @minibot/mobile`、`npm run lint` 通过。
- 截图：配对页、对话列表（含运行中与待审批标记）、对话页（含审批卡片与图片）、设置抽屉，浅色与深色各一组。
- 同一 Wi-Fi：状态条显示"局域网"；关掉 Wi-Fi：自动切到"中继"，进行中的回复继续流式显示。
- 一次发 4 张手机相册原图 → 电脑端收到。
- 电脑端撤销 → 手机回到配对页并显示撤销文案。

- [ ] **Step 1:** 按 **思路** 与 **约束** 实现。
- [ ] **Step 2:** 运行 `npm run build --workspace @minibot/mobile && npm run lint` — PASS。
- [ ] **Step 3:** `npx cap sync android` 后装到真机，按 **验收** 检查并截图。
- [ ] **Step 4:** 提交。

### Task 6：打包、签名与使用说明

**Files:**
- Modify: `apps/mobile/package.json`（`build`、`apk` 脚本）、`apps/mobile/android/app/build.gradle`（release 签名读环境变量）
- Create: `apps/mobile/README.md`

**思路:**
- `npm run apk --workspace @minibot/mobile` = 构建网页 → `npx cap sync android` → `./gradlew assembleRelease`，产物路径在 README 写明。
- README（中文）：准备 JDK / Android SDK、生成 keystore 的命令、四个环境变量、出包与安装（`adb install` 或直接传文件）、首次使用（电脑端"手机"页配对 → 通知权限 → 电池优化白名单）、常见国产系统的后台保活设置入口说明。

**约束:**
- 缺少任一签名环境变量时 `assembleRelease` 失败并提示缺哪个，不得回退到 debug 签名。
- keystore 文件与口令不入库；`.gitignore` 覆盖 `*.jks`、`*.keystore`。

**验收（手动）：**
- 未设环境变量运行 `npm run apk --workspace @minibot/mobile` → 失败并提示变量名。
- 设好后产出已签名 release APK，真机覆盖安装后已有配对仍有效。

- [ ] **Step 1:** 按 **思路** 与 **约束** 实现，写 README。
- [ ] **Step 2:** 按 **验收** 手动检查。
- [ ] **Step 3:** 提交。
