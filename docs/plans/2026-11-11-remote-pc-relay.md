# 远程控制（一）：加密协议、中继与电脑端 实现计划

> **For agentic workers:** Implement this plan task-by-task, in order. Each task's requirements include the Global Constraints below; each task's Interfaces block tells you the names and types neighboring tasks use. The plan gives approach and constraints only — you write the tests and the code. Steps use checkbox (`- [ ]`) syntax for tracking — tick each one as it is done.

**Goal：** 电脑端能被已配对的"手机"通过自建中继或局域网、经端到端加密安全地使用聊天 / 审批 / 对话管理；附带中继程序、电脑端"手机"设置页与托盘常驻。

**Architecture：** 把现有 HTTP 路由抽成与传输无关的分发函数，本机服务与远程网关共用。`packages/core/src/remote/` 实现 Noise（`node:crypto`）、分块加密信道、设备与身份存储、远程网关；网关通过两种承载（中继连接、局域网监听）接入手机会话，解密后按白名单调用分发函数、转发内核事件。`packages/relay` 是只转发密文小块的独立 Node 程序。安卓 App 不在本计划内（见计划二），本计划用 Node 写的"测试手机"验证全链路。

**Tech Stack：** TypeScript 5.9.3、Node 24.22（Electron 45.2.3 内置）、`node:crypto`、`node:test`、`ws` 8.22.1、React 19 + Tailwind v4（设置页）、`qrcode-generator` 1.4.4（设置页二维码，唯一新增依赖）。

**Spec：** `docs/specs/2026-11-11-android-remote-design.md`（以下简称"设计"）。本计划覆盖设计第 6.1–6.5 节、6.4.1 节与第 8 节中电脑端 / 中继部分；6.6 安卓 App 与 `api.ts` 传输抽象另写计划二。

**与设计的两处偏差（已定）：**
- 设计 6.1 的"单帧上限 8 MB"改为：应用消息先切成 Noise 传输消息（每块 ≤ 65535 字节），中继只转发小块，帧上限 `67584` 字节；接收端拼回后的应用消息上限 `37748736` 字节（36 MiB，覆盖发消息接口的 32 MB）。
- 设计 6.1 的"手机随机生成 sessionId"改为由中继生成，手机无法伪造。
- 设计 6.4 的"远程操作在日志里标记设备名"：项目目前没有通用日志，本计划只记录设备的最后在线时间与方式，不新建日志设施。
- 实施中追加（代码审核后）：电脑在中继注册时须用长期私钥回答一次性挑战（Task 3、Task 6）；二维码颜色用专用 token `qr-paper` / `qr-ink`，深浅色都是黑码白底（Task 7）。详见文末"实施记录"。

## Global Constraints

- 运行时以 Node 24.22（Electron 45.2.3 内置）为准；TypeScript `strict`、`erasableSyntaxOnly`（不用 enum / namespace / 参数属性），相对导入写 `.ts` 后缀。
- 测试用 `node:test` + `node:assert/strict`；`npm test` 跑 `packages/core/test/*.test.ts` 与（本计划新增）`packages/relay/test/*.test.ts`。
- 新增依赖只允许 `qrcode-generator@1.4.4`（渲染端）；加密只用 `node:crypto`，不加任何 Noise / sodium 库，不加原生模块。
- 现有 `127.0.0.1` 本机服务的绑定地址、`Host`/`Origin` 校验、令牌机制**一律不改**。
- 审批只能经 `kernel.respondApproval` 一处生效；远程与本机不得各有一份审批逻辑。
- 远程来源能调用的接口由一张白名单表决定，白名单外一律 403、`code: "remote_forbidden"`。
- Noise 协议名固定为 `Noise_XXpsk3_25519_ChaChaPoly_SHA256`（配对）与 `Noise_KK_25519_ChaChaPoly_SHA256`（日常），prologue 为 UTF-8 字节 `minibot-remote/1`。
- 电脑长期私钥与中继口令只经 `KeyCrypto` 加密落盘；`canPersist()` 为假时手机功能整体不可用，绝不以明文或每次新生成的方式兜底。
- 所有落盘文件经 `atomicWriteFile`。
- 界面文字只有简体中文，渲染端文案集中在 `apps/renderer/src/i18n.ts`；颜色只用语义 token 工具类，复用 `src/ui/recipes.ts` 与 `src/ui/` 浮层组件（`.claude/CLAUDE.md`）。

## Review Focus

1. 用户发 4 张大图片（请求体接近 32 MB）给手机端会话 → 应正常发出，不被中继或分块上限截断（Task 2、Task 5）。
2. 电脑网络切换 / 中继重启 → 电脑自动以退避重连，手机侧收到 `pc_offline` 后再收到 `pc_online`，重新握手即可继续（Task 3、Task 6）。
3. 配对二维码有效期内有人用错误密钥连续尝试 → 不影响真正的手机配对，满 5 次失败后该二维码作废（Task 5）。
4. 正在审批的设备被撤销 → 该设备所有会话立即断开，之后用旧密钥握手被拒（Task 5）。
5. 局域网端口被占用或系统无密钥库 → "手机"页显示原因，内核与本机界面照常可用，不抛出未处理异常（Task 6、Task 7）。

---

### Task 1：路由抽离与远程白名单

**Files:**
- Create: `packages/core/src/server/dispatch.ts`、`packages/core/src/remote/allowlist.ts`
- Modify: `packages/core/src/server/routes.ts`（改成调用 `dispatchApi` 的 HTTP 适配层）、`packages/core/src/server/server.ts`（如需）
- Test: `packages/core/test/dispatch.test.ts`、`packages/core/test/remote-allowlist.test.ts`

**Interfaces:**
- Produces:
  - `interface ApiRequest { method: string; url: URL; readBody(maxBytes: number): Promise<unknown> }`
  - `type ApiResponse = { status: number; json: unknown } | { status: number; bytes: Buffer; contentType: string; headers?: Record<string, string> }`
  - `dispatchApi(kernel: Kernel, req: ApiRequest): Promise<ApiResponse>`（内部吞掉 `HttpError` / `KernelError` / 未知错误，转换规则与现在 `handleApi` 完全相同）
  - `isRemoteAllowed(method: string, pathname: string): boolean`
  - `REMOTE_FORBIDDEN: ApiResponse`（`403`，`{ error: { code: 'remote_forbidden', message: '手机端不能使用此功能' } }`）

**思路:**
- 把 `route()` 里所有 `sendJson(res, …)` 改成返回 `ApiResponse`；读请求体改调 `req.readBody(limit)`，本机 HTTP 适配层用现有 `readJsonBody` 的流式限长实现它。附件接口返回 `bytes` 形态，带原 `cache-control` 头。
- `handleApi` 只做：构造 `ApiRequest` → `dispatchApi` → 写回响应。
- 白名单是一张 `{ method, pattern: RegExp }[]` 表，逐条匹配；表外即拒。

**约束:**
- 白名单内容严格按设计 6.4：读 `GET /api/state`、`/api/running`、`/api/approvals`、`/api/search`、`/api/bots/:id/threads`、`/api/threads/:id/messages`、`/api/threads/:id`、`/api/threads/:id/usage`、`/api/attachments/:id`；写 `POST /api/bots/:id/threads`、`POST /api/threads/:id/messages`、`PATCH /api/threads/:id`、`DELETE /api/threads/:id`、`POST /api/threads/:id/retry`。
- `:id` 段匹配 `[^/]+`，不得匹配多段。
- 本机接口的所有现有行为（状态码、错误码、文案、请求体上限 1 MB / 32 MB）不变。

**验收:**
- `server.test.ts` 现有用例全部通过（行为回归）。
- `dispatch 附件`：存在的附件 → `bytes` 形态，`contentType` 为图片类型。
- `dispatch 错误转换`：不存在的线程 → `status 404`，`code: 'not_found'`。
- `allowlist 放行`：上面列出的 14 条各一例 → `true`。
- `allowlist 拒绝`：`PUT /api/settings`、`POST /api/providers`、`POST /api/onboarding`、`PUT /api/memory/file`、`GET /api/memory/file`、`PATCH /api/bots/b1`、`GET /api/presets`、`GET /api/approvals/log`、`POST /api/threads/t1/compact`、`GET /api/threads/t1/context`、`POST /api/memory/revisions/r1/revert`、`GET /api/remote` → 全部 `false`。
- `allowlist 多段`：`GET /api/threads/a/b/messages` → `false`。
- `state 不含 Key`：配置了带 Key 的供应商后，`dispatchApi` 的 `/api/state` 结果序列化文本不含该 Key 原文。

- [x] **Step 1:** 写 **验收** 中的测试；运行 `npm test` — 新测试 FAIL。
- [x] **Step 2:** 按 **思路** 与 **约束** 实现。
- [x] **Step 3:** 运行 `npm test && npm run lint` — PASS。
- [x] **Step 4:** 提交。

### Task 2：Noise 握手与分块加密信道

**Files:**
- Create: `packages/core/src/remote/noise.ts`、`packages/core/src/remote/channel.ts`
- Create: `packages/core/test/fixtures/noise-vectors.json`
- Test: `packages/core/test/noise.test.ts`、`packages/core/test/channel.test.ts`

**Interfaces:**
- Produces:
  - `interface KeyPair { publicKey: Buffer; privateKey: Buffer }`（各 32 字节原始值）
  - `generateKeyPair(): KeyPair`
  - `type NoisePattern = 'XXpsk3' | 'KK'`
  - `createHandshake(o: { pattern: NoisePattern; initiator: boolean; s: KeyPair; rs?: Buffer; psk?: Buffer; e?: KeyPair }): Handshake`（`e` 仅供测试向量注入）
  - `interface Handshake { writeMessage(payload: Buffer): Buffer; readMessage(message: Buffer): Buffer; isComplete(): boolean; remoteStatic(): Buffer | null; handshakeHash(): Buffer; split(): { send: CipherState; recv: CipherState } }`
  - `interface CipherState { encrypt(plain: Buffer): Buffer; decrypt(cipher: Buffer): Buffer }`
  - `interface Carrier { send(frame: Buffer): void; onFrame(cb: (frame: Buffer) => void): void; onClose(cb: () => void): void; close(): void; bufferedAmount?(): number }`（`onFrame` 是设置处理函数，后设的覆盖先设的；`bufferedAmount` 为已交给承载、尚未发出的字节数）
  - `class SecureChannel { constructor(carrier: Carrier, send: CipherState, recv: CipherState); send(message: unknown): void; onMessage(cb: (message: unknown) => void): void; onClose(cb: () => void): void; close(): void }`
  - 线上帧类型常量：`FRAME_PAIR = 0x01`、`FRAME_KK = 0x02`、`FRAME_DATA = 0x03`

**思路:**
- 按 Noise 规范第 5 章实现 CipherState / SymmetricState / HandshakeState；DH 用 `crypto.diffieHellman` 配 X25519 `KeyObject`（原始 32 字节 ↔ KeyObject 用固定的 PKCS8 / SPKI DER 前缀拼接）；AEAD 用 `chacha20-poly1305`，nonce 为 4 个零字节 + 8 字节小端计数；HKDF 用 `hkdfSync('sha256', ikm, ck, 空 info, 64 或 96)`。
- 两种模式的消息模式写成数据表（`XXpsk3`: `-> e` / `<- e, ee, s, es` / `-> s, se, psk`；`KK` 预消息双方 `s`，`-> e, es, ss` / `<- e, ee, se`）。
- `SecureChannel`：应用消息 JSON 序列化为 UTF-8，切块；每块明文 = 1 字节标志（`0` 还有后续、`1` 最后一块）+ 至多 `65518` 字节数据；每块加密后加前缀 `FRAME_DATA` 发出。接收端按顺序拼接，到最后一块时解析 JSON 回调。

**约束:**
- 单个 Noise 传输消息密文 ≤ `65535` 字节。
- 拼接中的应用消息累计超过 `37748736` 字节 → 关闭信道。
- 任一块解密失败、帧类型不是 `FRAME_DATA`、JSON 解析失败 → 关闭信道，不回调。
- 发送前承载积压（`bufferedAmount`）超过 `16777216` 字节 → 关闭信道（对端太慢或链路卡住；手机重连后重新同步）。
- 测试向量取自 cacophony（`https://github.com/haskell-cryptography/cacophony` 的 `vectors/cacophony.txt`），只摘出上面两种协议名的条目存成 fixture。

**验收:**
- `noise 向量 XXpsk3`、`noise 向量 KK`：fixture 中每条用例的每条握手消息与传输消息密文逐字节一致，握手哈希一致。
- `noise 错误 psk`：响应方 psk 与发起方不同 → 第 3 条消息 `readMessage` 抛错。
- `noise KK 错误公钥`：发起方用未知的 `s` → 响应方读第 1 条消息抛错。
- `channel 往返`：一对内存 Carrier 上互发 `{a:1}` → 对端收到相同对象。
- `channel 大消息`：发送 30 MB 字符串字段的消息 → 对端完整收到，期间每帧长度 ≤ `65536`。
- `channel 超限`：接收方累计超过 `37748736` 字节 → 信道关闭、无回调。
- `channel 篡改`：翻转一个密文字节 → 接收方关闭信道。
- `channel 重放`：同一帧投递两次 → 第二次导致关闭。
- `channel 积压`：承载积压超过上限时再发送 → 信道关闭、不再发帧。

- [x] **Step 1:** 摘出测试向量 fixture；写 **验收** 测试；运行 `npm test` — FAIL。
- [x] **Step 2:** 按 **思路** 与 **约束** 实现。
- [x] **Step 3:** 运行 `npm test && npm run lint` — PASS。
- [x] **Step 4:** 提交。

### Task 3：中继程序 `packages/relay`

**Files:**
- Create: `packages/relay/package.json`（`@minibot/relay`，依赖 `ws@8.22.1`）、`packages/relay/tsconfig.json`、`packages/relay/src/relay.ts`、`packages/relay/src/main.ts`、`packages/relay/Caddyfile.example`、`packages/relay/README.md`
- Modify: 根 `package.json`（workspaces、`build`、`test` 加上 relay）
- Test: `packages/relay/test/relay.test.ts`

**Interfaces:**
- Produces:
  - `startRelay(o: { host: string; port: number; token: string; now?: () => number; log?: (message: string) => void; helloTimeoutMs?: number; trustProxy?: boolean }): Promise<{ port: number; close(): Promise<void> }>`
  - `pcProof(shared: Buffer, nonce: Buffer, routeId: string): Buffer`
  - 中继协议（文本帧 JSON）：客户端 → 中继 `{"type":"hello","role":"pc"|"phone","routeId":"<32位hex>","token":"…"}`，电脑另带 `"pk":"<base64url 公钥>"`；中继 → 电脑 `{"type":"challenge","epk":"<base64url 一次性 X25519 公钥>","nonce":"<base64url 32 字节>"}`；电脑 → 中继 `{"type":"proof","proof":"<base64url>"}`，`proof = HMAC-SHA256(SHA-256("minibot-relay-auth/1" ‖ X25519(电脑私钥, epk)), nonce ‖ routeId 原始 16 字节)`；中继 → 客户端 `{"type":"welcome"}`；中继 → 手机 `{"type":"pc_online"}` / `{"type":"pc_offline"}`；中继 → 电脑 `{"type":"session_open","sessionId":"<32位hex>"}` / `{"type":"session_close","sessionId":"…"}`；电脑 → 中继 `{"type":"session_close","sessionId":"…"}`。
  - 二进制帧：电脑侧每帧前 16 字节为 sessionId 原始字节，其后为负载；手机侧只有负载。

**思路:**
- 一个 `WebSocketServer`，路径 `/v1`。首条消息必须是 `hello`，`token` 用常量时间比较。
- 电脑 `hello` 通过口令校验后：`routeId` 必须等于 `SHA-256(pk)` 前 16 字节，否则 `4403`；随后发 `challenge`，核对 `proof`（常量时间比较）通过才进入下面的注册流程。口令写在配对二维码里，只挡没有口令的人；能否以电脑身份注册只看私钥。
- 每个 `routeId` 一条记录：当前电脑连接 + 若干手机会话（sessionId → 手机连接）。手机接入时由中继生成 sessionId；电脑在线则向电脑发 `session_open` 并给手机发 `pc_online`，否则给手机发 `pc_offline` 并保留等待。
- 电脑注册时：若已有旧电脑连接，以 `4409` 关闭旧连接；对所有等待中的手机逐个发 `session_open` 与 `pc_online`。电脑断开：对所有手机发 `pc_offline`，保留手机连接。
- 转发只拼接 / 剥离 sessionId 前缀，不解析负载。
- `main.ts` 从环境变量读 `RELAY_HOST`（默认 `127.0.0.1`）、`RELAY_PORT`（默认 `8787`）、`RELAY_TOKEN`（必填）、`RELAY_TRUST_PROXY`（设为 `1` 时打开 `trustProxy`）。

**约束:**
- `RELAY_TOKEN` 缺失或少于 16 个字符 → 打印中文原因并以非零码退出。
- 关闭码：`4400` hello / proof 格式不对或 5 秒内未完成、`4401` 口令错误、`4403` 电脑身份验证失败（公钥与路由不符、证明错误）、`4409` 被通过身份证明的新电脑连接顶替、`4413` 帧超过 `67584` 字节、`4429` 限流。
- 每个 routeId 最多 8 个手机会话，超出以 `4429` 拒绝新手机。
- 每个 IP 每 60 秒最多 30 次新连接。`trustProxy` 打开时，来自回环地址的连接按 `X-Forwarded-For` 最右一项（反代追加的真实地址）计数，最左边可伪造的值不参与。
- 每 25 秒 ping，60 秒无 pong 断开。
- 不落盘、不打印任何负载内容；只打印连接数变化与错误。
- 不提供 Docker。README 用中文写：服务器上装 Node 24 后 `npm run build` 再 `node` 直跑、用 systemd 常驻的示例单元文件、Caddy 反代出 `wss://` 的示例（中继保持默认只监听 `127.0.0.1`），说明 `ws://` 只会暴露元数据。

**验收:**
- `relay 转发`：电脑与手机同 routeId → 手机发 `[1,2,3]` 电脑收到 `sessionId + [1,2,3]`；电脑回 `sessionId + [4]` → 手机收到 `[4]`。
- `relay 多手机`：两部手机 → 电脑收到两个不同 sessionId，回包只到对应手机。
- `relay 电脑离线`：手机先连 → 收到 `pc_offline`；电脑随后注册 → 手机收到 `pc_online`、电脑收到 `session_open`。
- `relay 顶替`：同 routeId 第二台电脑注册 → 第一台以 `4409` 关闭，手机收到 `pc_offline` 后 `pc_online`。
- `relay 口令错`、`relay 无 hello`、`relay 超大帧`、`relay 第 9 部手机` → 分别以 `4401`、`4400`、`4413`、`4429` 关闭。
- `relay 电脑踢会话`：电脑发 `session_close` → 对应手机连接被关闭。
- `relay 启动校验`：`RELAY_TOKEN` 为 `short` → 进程退出码非零。
- `relay 反代后按真实 IP 限流`：同一真实 IP 第 31 次 → `4429`，另一个真实 IP 不受影响。
- `relay 冒充电脑`：有口令、知道公钥但答不出挑战 → `4403`，原电脑与手机不受影响；公钥与路由不符 → `4403`；不答挑战 → `4400`。

- [x] **Step 1:** 写 **验收** 测试；运行 `npm test` — FAIL。
- [x] **Step 2:** 按 **思路** 与 **约束** 实现，写 README / systemd 与 Caddy 示例。
- [x] **Step 3:** 运行 `npm test && npm run build && npm run lint` — PASS。
- [x] **Step 4:** 提交。

### Task 4：远程身份、配置与设备存储

**Files:**
- Create: `packages/core/src/remote/store.ts`
- Modify: `packages/core/src/paths.ts`（新增 `remoteJson`、`remoteKey`、`devicesJson`）
- Test: `packages/core/test/remote-store.test.ts`

**Interfaces:**
- Consumes: `KeyPair`、`generateKeyPair`（Task 2）；`KeyCrypto`、`atomicWriteFile`
- Produces:
  - `interface RemoteConfig { relayUrl: string | null; lanEnabled: boolean; lanPort: number; pcName: string }`
  - `interface Device { id: string; name: string; publicKey: string; pairedAt: number; lastSeenAt: number | null; lastVia: 'lan' | 'relay' | null }`
  - `class RemoteStore { static open(o: { paths: DataPaths; crypto: KeyCrypto; platform?: NodeJS.Platform }): Promise<RemoteStore>; available(): boolean; identity(): KeyPair; routeId(): string; config(): RemoteConfig; relayToken(): string | null; updateConfig(patch: Partial<RemoteConfig> & { relayToken?: string | null }): Promise<void>; devices(): Device[]; findDevice(id: string): Device | null; addDevice(name: string, publicKey: Buffer): Promise<Device>; removeDevice(id: string): Promise<boolean>; touch(id: string, via: 'lan' | 'relay'): Promise<void> }`
  - `deviceIdOf(publicKey: Buffer): string`

**思路:**
- 三个文件：`remote.json`（`RemoteConfig`，明文）、`remote-key.bin`（`KeyCrypto` 加密的 `{ privateKey, publicKey, relayToken }`）、`devices.json`（`Device[]`，只含公钥）。
- `available()` 规则与 `SecretStore.canPersist()` 一致（Linux 且后端为 `basic_text` 时为假）。不可用时不生成、不读取身份，`identity()` 抛错。
- 首次可用时生成身份并落盘；`remote-key.bin` 解密失败时视为不可用（不覆盖原文件）。
- `routeId` 与 `deviceIdOf` 都是公钥 SHA-256 前 16 字节的小写 hex。`publicKey` 字段为 base64url。

**约束:**
- 默认配置：`relayUrl: null`、`lanEnabled: true`、`lanPort: 47821`、`pcName: os.hostname()`。
- `relayUrl` 必须是 `ws://` 或 `wss://` 开头，否则 `KernelError('invalid', '中继地址必须以 ws:// 或 wss:// 开头')`。
- `lanPort` 为 1024–65535 的整数，否则 `KernelError('invalid', '端口必须是 1024 到 65535 之间的整数')`。
- `pcName` 去首尾空白后 1–40 个字符；设备名同样规则，超长截断。
- `touch` 只更新内存并节流落盘（同一设备 60 秒内最多写一次）。

**验收:**
- `store 首次生成`：空目录 → 生成身份，重开后 `identity().publicKey` 不变、`routeId()` 为 32 位 hex。
- `store 不可用`：`platform: 'linux'` 且 crypto 后端 `basic_text` → `available()` 为 `false`，目录里没有 `remote-key.bin`。
- `store 无法解密`：`remote-key.bin` 内容损坏 → `available()` 为 `false`，文件保持原样。
- `store 私钥不落明文`：生成后读三个文件原文 → 都不含私钥的 base64url / hex 文本。
- `store 设备增删`：加两台、删一台 → 重开后只剩一台，`removeDevice` 不存在的 id 返回 `false`。
- `store 配置校验`：`relayUrl: 'http://x'`、`lanPort: 80` → 分别抛上面两条文案。

- [x] **Step 1:** 写 **验收** 测试；运行 `npm test` — FAIL。
- [x] **Step 2:** 按 **思路** 与 **约束** 实现。
- [x] **Step 3:** 运行 `npm test && npm run lint` — PASS。
- [x] **Step 4:** 提交。

### Task 5：远程网关（会话、配对、请求与事件）

**Files:**
- Create: `packages/core/src/remote/gateway.ts`、`packages/core/src/remote/pairing.ts`
- Create: `packages/core/test/remote-phone.ts`（测试用"手机"：基于 Task 2 的握手 + 信道）
- Test: `packages/core/test/remote-gateway.test.ts`

**Interfaces:**
- Consumes: `dispatchApi`、`isRemoteAllowed`、`REMOTE_FORBIDDEN`（Task 1）；`createHandshake`、`SecureChannel`、`Carrier`、帧类型常量（Task 2）；`RemoteStore`、`Device`、`deviceIdOf`（Task 4）；`Kernel.on`、`Kernel.respondApproval`、`Kernel.abort`
- Produces:
  - `interface PairingOffer { code: string; expiresAt: number }`（`code` 即二维码文本）
  - `class RemoteGateway { constructor(kernel: Kernel, store: RemoteStore, o?: { now?: () => number; handshakeTimeoutMs?: number }); accept(carrier: Carrier, via: 'lan' | 'relay'): void; startPairing(extra: { lanAddresses: string[] }): PairingOffer; cancelPairing(): void; pairing(): PairingOffer | null; revoke(deviceId: string): Promise<boolean>; onlineDeviceIds(): string[]; on(listener: () => void): () => void; close(): void }`
  - 应用层消息（JSON，信道内）：`{t:'req', id, method, path, body?}`、`{t:'res', id, status, body?}` 或 `{t:'res', id, status, bytes, contentType}`（`bytes` 为 base64）、`{t:'evt', event}`、`{t:'ctl', msg}`、`{t:'ready', pcName}`、`{t:'paired', deviceId}`

**思路:**
- 握手帧格式：每个握手消息一帧。配对三条消息都是 `[0x01][Noise 消息]`；日常连接手机首帧 `[0x02][16 字节 deviceId][msg1]`，电脑回 `[0x02][msg2]`。电脑回完最后一条握手消息后立刻发 `ready`，手机侧换帧处理函数时须缓冲，不能丢帧（测试手机 `remote-phone.ts` 的 `buffered` 即为此）。
- `accept`：等第一帧。`FRAME_PAIR` → 若有有效配对邀请，以 `XXpsk3` 响应方处理；msg2 载荷为 `{pcName}` JSON，msg3 载荷为 `{deviceName}` JSON；成功后 `addDevice`、作废邀请、发 `{t:'paired'}` 再发 `{t:'ready'}`，会话直接继续。`FRAME_KK` → 帧体前 16 字节为 deviceId，查设备取公钥作 `rs`，以 `KK` 响应方处理；成功后发 `{t:'ready'}`。
- 会话建立后：订阅 `kernel.on`，把事件包成 `evt` 发出（过滤 `memory_changed`）；`req` → 白名单检查 → 构造 `ApiRequest`（`readBody` 返回消息里的 `body`，超过该路由上限则 413）→ `dispatchApi` → `res`；`ctl` 只接受 `abort` 与 `approval` 两种，字段校验与本机 WS 相同，分别调 `kernel.abort` / `kernel.respondApproval`。
- 维护 `deviceId → 会话集合`；`revoke` 删除设备并关闭其全部会话；会话开 / 关、配对完成、撤销时触发 `on` 监听者。会话建立时 `store.touch`。
- 配对码 = `minibot-pair:` + base64url(JSON `{v:1, relay, token, pk, psk, name, lan, port}`)，字段取自 store 的配置、中继口令、电脑公钥、32 字节随机 psk、电脑名、传入的局域网地址与 `lanPort`。

**约束:**
- 握手须在 `10000` ms 内完成，否则关闭承载。
- 配对邀请有效期 `300000` ms；同一时间只有一份，新邀请替换旧的；成功一次即作废；累计 5 次握手失败即作废。
- 没有有效邀请时收到 `FRAME_PAIR`、或 KK 的 deviceId 未知 → 直接关闭，不回任何内容。
- 第一帧既不是 `FRAME_PAIR` 也不是 `FRAME_KK` → 关闭。
- `store.available()` 为假时 `accept` 直接关闭承载，`startPairing` 抛 `KernelError('invalid', '当前系统没有可用的密钥库，无法使用手机功能')`。

**验收:**
- `gateway 配对`：开邀请 → 测试手机用码配对 → 收到 `paired` 与 `ready`，`store.devices()` 多一台，同码再配对被关闭。
- `gateway 邀请过期`：`now` 前进 300001 ms → 配对被关闭。
- `gateway 5 次失败`：用错误 psk 试 5 次 → 第 6 次用正确 psk 也被关闭。
- `gateway 日常连接`：已配对手机 KK 握手 → 收到 `ready`；`GET /api/state` 请求得到 `status 200`。
- `gateway 白名单`：`PUT /api/settings` → `status 403`、`code: 'remote_forbidden'`。
- `gateway 发图片`：`POST /api/threads/:id/messages` 带 4 张约 5 MB 的图片 → `status 200`，线程出现该消息。
- `gateway 事件`：假模型回复 → 手机依次收到 `turn running`、`delta`、`message`、`turn idle` 的 `evt`；不收到 `memory_changed`。
- `gateway 审批`：触发审批 → 手机收到 `approval_request`；回 `ctl approval approve:true` → 该审批被批准，本机 WS 客户端收到 `approval_resolved`。
- `gateway 撤销`：撤销已连接设备 → 其会话关闭；再用原密钥 KK 握手被关闭。
- `gateway 未知设备`、`gateway 握手超时`、`gateway 垃圾首帧` → 承载被关闭。
- `gateway 配对完成瞬间手机断开`：设备照常保存、邀请作废，并通知 `on` 监听者。

- [x] **Step 1:** 写测试手机与 **验收** 测试；运行 `npm test` — FAIL。
- [x] **Step 2:** 按 **思路** 与 **约束** 实现。
- [x] **Step 3:** 运行 `npm test && npm run lint` — PASS。
- [x] **Step 4:** 提交。

### Task 6：承载（中继连接、局域网监听）与远程服务装配

**Files:**
- Create: `packages/core/src/remote/relay-link.ts`、`packages/core/src/remote/lan-listener.ts`、`packages/core/src/remote/service.ts`
- Modify: `packages/core/src/server/dispatch.ts`（本机专用管理路由）、`packages/core/src/server/server.ts`（`ServerOptions.remote`，向本机 WS 推 `remote_changed`）、`packages/core/src/events.ts`、`packages/core/src/index.ts`
- Test: `packages/core/test/remote-service.test.ts`

**Interfaces:**
- Consumes: Task 3 中继协议与 `startRelay`（测试用）；`RemoteGateway`、`RemoteStore`、`Carrier`
- Produces:
  - `interface RemoteStatus { available: boolean; config: RemoteConfig; hasRelayToken: boolean; relay: 'off' | 'connecting' | 'connected' | 'error'; relayError: string | null; lan: 'off' | 'listening' | 'error'; lanError: string | null; devices: (Device & { online: boolean })[]; pairing: { code: string; expiresAt: number } | null }`
  - `class RemoteService { static start(kernel: Kernel, o: { dataRoot: string; crypto: KeyCrypto; platform?: NodeJS.Platform }): Promise<RemoteService>; status(): RemoteStatus; hasDevices(): boolean; updateConfig(patch: Partial<RemoteConfig> & { relayToken?: string | null }): Promise<RemoteStatus>; startPairing(): RemoteStatus; cancelPairing(): RemoteStatus; revoke(deviceId: string): Promise<RemoteStatus>; on(listener: () => void): () => void; close(): Promise<void> }`
  - `ServerOptions.remote?: RemoteService`
  - `KernelEvent` 新增 `{ type: 'remote_changed' }`（只经本机 WS 推送）
  - 本机路由（不在远程白名单内）：`GET /api/remote` → `RemoteStatus`；`PUT /api/remote` → body 为 `updateConfig` 的 patch；`POST /api/remote/pairing`；`DELETE /api/remote/pairing`；`DELETE /api/remote/devices/:id`。均返回最新 `RemoteStatus`；未传 `remote` 时 404。

**思路:**
- `relay-link`：配置了 `relayUrl` 与口令、且有设备或有进行中的配对邀请时连接；发 `hello`（`role: 'pc'`，带公钥 `pk`），收到 `challenge` 用电脑长期私钥回 `proof`，收到 `session_open` 就为该 sessionId 造一个 `Carrier`（发送时加 16 字节前缀、关闭时发 `session_close`）交给 `gateway.accept(…, 'relay')`；`session_close` 关闭对应 Carrier。断线按 1s 起翻倍、上限 60s 重连，成功后重置。
- `lan-listener`：`lanEnabled` 且有设备或有配对邀请时，`http.createServer` 监听 `0.0.0.0:lanPort`；只接受路径 `/v1` 的 WebSocket 升级，其余请求一律 404；每条 WS 连接包成 Carrier 交给 `gateway.accept(…, 'lan')`。
- `service`：组装 store + gateway + 两种承载；配置变化、设备增删、配对开始 / 结束时按上面的条件启停承载；`startPairing` 用 `os.networkInterfaces()` 中非内部的 IPv4 地址填 `lanAddresses`；任何状态变化触发 `on`。
- `server.ts` 订阅 `remote.on`，向已鉴权的本机 WS 客户端推 `{type:'remote_changed'}`。
- `index.ts` 导出 `RemoteService` 与类型 `RemoteStatus`、`RemoteConfig`、`Device`，供桌面主进程与渲染端使用。

**约束:**
- 中继 / 局域网的启动失败（如 `EADDRINUSE`、DNS 失败、`4401`）只写入 `relayError` / `lanError` 并触发 `on`，不抛出、不影响内核。错误文案中文，如 `端口 47821 已被占用`、`中继口令错误`。
- 收到中继 `4401` 或 `4403` 时不再自动重连，直到配置变更或用户开始配对。`4409`（被同一身份的连接顶替）按退避重连，且重连成功后不重置退避，避免两份同身份实例每秒互踢。
- 到中继的连接每 `25000` ms ping 一次，下一轮未收到 pong 即断开重连（电脑睡眠、换网后的半开连接）。
- 密钥写盘失败（如系统加密不可用）→ `available` 为假，`RemoteService.start` 不抛出；桌面主进程另有兜底，手机功能出错不影响启动。
- `close()` 关闭全部会话、承载与监听。
- `RemoteStatus` 与 `/api/remote` 响应绝不包含中继口令与私钥（配对码只在 `pairing.code` 中出现）。

**验收:**
- `service 中继全链路`：本地 `startRelay` + 服务配置该中继 → 测试手机经中继配对、断开、再 KK 连接 → 收到 `ready`，`status().devices[0].lastVia` 为 `'relay'`。
- `service 局域网全链路`：同上走 `ws://127.0.0.1:<lanPort>/v1` → `lastVia` 为 `'lan'`。
- `service 局域网非 v1`：`GET http://127.0.0.1:<lanPort>/` → 404。
- `service 无设备不监听`：无设备、无邀请 → `lan` 为 `'off'`，端口未监听。
- `service 端口占用`：先占用 lanPort 再开邀请 → `lan` 为 `'error'`，`lanError` 含 `已被占用`，内核正常。
- `service 中继重连`：中继关掉再起 → 服务回到 `connected`，已配对手机可再连。
- `service 口令错`：中继口令不匹配 → `relay` 为 `'error'`，之后不再重连。
- `service 中继停止后，重新开始配对会重试`：中继改对口令重启后，电脑端配置不变，重新开始配对 → `connected`。
- `relay-link`：半开连接收不到 pong → 断开重连；能通过真实中继的身份挑战；被同一身份顶替后退避重连。
- `server 管理路由`：本机 `GET /api/remote` 带令牌 → 200 且不含口令；远程会话请求 `/api/remote` → 403。
- `server remote_changed`：本机 WS 客户端在配对完成时收到 `{type:'remote_changed'}`。

- [x] **Step 1:** 写 **验收** 测试；运行 `npm test` — FAIL。
- [x] **Step 2:** 按 **思路** 与 **约束** 实现。
- [x] **Step 3:** 运行 `npm test && npm run build && npm run lint` — PASS。
- [x] **Step 4:** 提交。

### Task 7：桌面端"手机"设置页

**Files:**
- Create: `apps/renderer/src/settings/PhonePage.tsx`、`apps/renderer/src/settings/PairingDialog.tsx`
- Modify: `apps/renderer/src/settings/SettingsDialog.tsx`（新增 `phone` 页）、`apps/renderer/src/api.ts`（`remote*` 方法）、`apps/renderer/src/i18n.ts`、`apps/renderer/package.json`（`qrcode-generator@1.4.4`）
- Modify: `apps/desktop/src/main.cts`（启动 `RemoteService` 并传给 `startServer`，退出时 `close`）

**Interfaces:**
- Consumes: Task 6 的本机管理路由、`RemoteStatus`、`remote_changed` 事件
- Produces: `api.remoteStatus(): Promise<RemoteStatus>`、`api.updateRemote(patch): Promise<RemoteStatus>`、`api.startPairing(): Promise<RemoteStatus>`、`api.cancelPairing(): Promise<RemoteStatus>`、`api.revokeDevice(id: string): Promise<RemoteStatus>`

**思路:**
- 页面布局照设计 6.5 的草图：中继地址、中继口令（密码框，只写不读，显示"已设置"）、状态点、局域网直连开关与端口、"配对新手机"按钮、已配对列表（名称、上次在线相对时间与方式、在线标记、撤销）。字段失焦或按回车时保存。
- 收到 `remote_changed` 重新拉取状态。
- 配对对话框用 `Dialog`：用 `qrcode-generator` 生成 SVG 显示 `pairing.code`，下方倒计时；设备列表数量增加时显示"已配对：<设备名>"，1.5 秒后自动关闭；关闭时调 `cancelPairing`。
- `available` 为假时整页只显示原因说明，不显示表单。
- 撤销前用 `Dialog` 二次确认。

**约束:**
- 文案全部进 `i18n.ts`；颜色只用语义 token；控件复用 `recipes.ts` 的 `FIELD`、`PILL_*` 等；二维码用 `styles.css` 里的专用 token `qr-paper` / `qr-ink`，深浅色模式都是黑码白底（反色码很多扫码器认不出），周围留白。
- 配对成功的判据是"有设备的 `pairedAt` 不早于对话框打开时间"（同一台手机重新配对时设备数不变）。
- 未配置中继也能配对（只走局域网）；未配置中继时页面提示"在外面使用需要配置中继服务器"。
- `relayUrl` 以 `ws://` 开头时显示提示："未加密的中继会暴露连接时间等信息，内容仍然加密"。
- 撤销确认文案：`撤销后这台手机会立即断开，需要重新扫码才能再连。`

**验收（手动）：**
- `npm run build --workspace @minibot/renderer` 与 `npm run build` 通过，`npm run lint` 无错误。
- 用 `MINIBOT_HOME` 指向临时目录启动桌面端，截图：空状态"手机"页、配对对话框（浅色与深色）、配对完成后的设备列表、撤销确认框。
- 用 Task 5 的测试手机脚本扫描码文本完成配对，页面无需刷新即出现新设备。
- 把 `lanPort` 设为被占用的端口 → 页面显示错误文案。

- [x] **Step 1:** 按 **思路** 与 **约束** 实现。
- [x] **Step 2:** 运行 `npm run build && npm run lint` — PASS。
- [x] **Step 3:** 按 **验收** 手动检查并截图。
- [x] **Step 4:** 提交。

### Task 8：关窗口缩到托盘

**Files:**
- Modify: `apps/desktop/src/main.cts`

**Interfaces:**
- Consumes: `RemoteService.hasDevices()`

**思路:**
- 主窗口 `close` 事件：若未处于退出流程且 `hasDevices()` 为真，`preventDefault` 并隐藏窗口；否则照旧关闭。
- 应用就绪后创建 `Tray`（图标用 `static/assets/icon.png` 缩放到托盘尺寸），菜单两项：`打开 minibot`、`退出`；单击托盘图标同"打开"。"退出"走现有 `before-quit` 清理流程。
- `window-all-closed`：有设备时不退出。`second-instance` 时若窗口隐藏则显示。
- 第一次因有设备而隐藏时发一条系统通知：`minibot 仍在后台运行，手机可以继续连接。可从托盘图标退出。`（是否已提示过记在内存即可，每次启动最多一次）。

**约束:**
- 没有已配对设备时，关闭窗口的行为与现在完全一致（直接退出）。
- 不做开机自启。

**验收（手动）：**
- `npm run build` 通过。
- 无设备：关窗口 → 进程退出。
- 有设备：关窗口 → 窗口消失、托盘可见、通知出现一次；测试手机仍能连上并收到 `ready`；托盘"打开 minibot"恢复窗口；托盘"退出"后进程结束且局域网端口释放。
- 在 Linux 与 Windows 各验证一次（Windows 可在打包后的安装包上验证）。

- [x] **Step 1:** 按 **思路** 与 **约束** 实现。
- [x] **Step 2:** 运行 `npm run build && npm run lint` — PASS。
- [ ] **Step 3:** 按 **验收** 手动检查。
- [x] **Step 4:** 提交。

---

## 实施记录

分支 `feat/remote-pc-relay`。8 个任务均已实现，`npm test`（core 与 relay）与 `npm run build` 通过。

**未完成 / 未按原方式验证**
- `npm run lint`：开发环境缺少 `typescript-eslint` 包无法运行，各步改用 `tsc --noEmit` 做类型检查。
- Task 7 手动验收：没有启动 Electron，改为用脚本起真实内核 + 远程服务 + 本机服务，用 Playwright 加载构建后的页面截图（空状态、配对对话框浅色 / 深色、配对后设备列表、同一手机重新配对、撤销确认、端口占用），并用 Node 测试手机完成真实配对。
- Task 8 Step 3（托盘、通知、Linux / Windows 各验证一次）：未做，需手动验证。

**代码审核后的修改**（均先写失败测试再修）
1. 中继要求电脑用私钥证明身份，拿到口令与公钥的人无法冒充电脑（Task 3、Task 6）。
2. 中继在反代后按真实客户端地址限流（`RELAY_TRUST_PROXY`）。
3. 电脑到中继的连接加心跳，发现半开连接后重连。
4. 中继因口令错误等停止后，用户改配置或开始配对时重试。
5. 配对最后一步后手机立刻断开、或保存设备失败时，仍通知界面刷新。
6. 同一台手机重新配对时对话框正确显示"已配对"。
7. 首次保存密钥失败不再让应用无法启动。
8. 加密信道发送积压超过 16 MiB 时断开会话。
9. 二维码颜色改用专用 token。
10. `packages/relay/dist/` 不再入库。
