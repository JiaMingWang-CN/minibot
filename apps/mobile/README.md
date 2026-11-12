# minibot 手机端（安卓）

自用安卓 App：扫码配对电脑后，经局域网直连或自建中继，在手机上选 bot、聊天（含图片）、中断、审批、翻历史，并在后台收到审批与完成通知。

界面是 Vite + React 工程（`src/`），直接复用桌面渲染端 `apps/renderer/src` 的样式、组件与对话逻辑；`android/` 是 Capacitor 工程，原生部分只有一个前台服务（持有到电脑的 Noise 加密连接）和一个 Capacitor 插件。私钥、psk、中继口令只在原生层。

## 准备环境

- JDK 21
- Android SDK（compileSdk 36，minSdk 26，targetSdk 35），设置 `ANDROID_HOME`，或在 `android/local.properties` 写 `sdk.dir=...`
- Node（与仓库根相同），根目录先 `npm install`

## 生成签名 keystore（只需一次）

```bash
keytool -genkeypair -v -keystore minibot.jks -alias minibot -keyalg RSA -keysize 2048 -validity 36500
```

keystore 与口令**不入库**（`.gitignore` 已忽略 `*.jks`、`*.keystore`），自己妥善备份；丢了就无法覆盖安装升级。

## 出包

设置四个环境变量（缺任何一个，`assembleRelease` 都会失败并指出缺哪个，不会回退到 debug 签名）：

| 变量 | 含义 |
| --- | --- |
| `MINIBOT_KEYSTORE` | keystore 文件路径 |
| `MINIBOT_KEYSTORE_PASSWORD` | keystore 口令 |
| `MINIBOT_KEY_ALIAS` | 密钥别名（上面是 `minibot`） |
| `MINIBOT_KEY_PASSWORD` | 密钥口令 |

```bash
npm run apk --workspace @minibot/mobile
```

等于：构建网页 → `npx cap sync android` → `./gradlew assembleRelease`。产物：

```
apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

安装：`adb install -r app-release.apk`，或直接把文件传到手机上点开。用同一个 keystore 签的包可以直接覆盖安装，已有配对仍然有效。

单元测试（Noise 官方向量、跨语言互通夹具、加密信道、连接管理、通知）：

```bash
npm run test:android --workspace @minibot/mobile
```

这条命令会先构建网页并执行 `npx cap sync android`。`android/capacitor-cordova-android-plugins/` 由 `cap sync` 生成、不入库，新克隆的仓库在直接用 Gradle 或 Android Studio 打开 `android/` 之前，也要先跑一次 `npm run build --workspace @minibot/mobile && npx cap sync android`（在 `apps/mobile` 下）。

互通夹具 `packages/core/test/fixtures/remote-interop.json` 由电脑端测试生成（`UPDATE_FIXTURES=1 npm test` 重写），Kotlin 端读同一个文件。

## 首次使用

1. 电脑端打开“手机”页，填好中继地址和口令（只在局域网内用可以不填），点“配对新手机”。
2. 手机打开 minibot，点“扫码配对”，扫电脑上的二维码。
3. 配对成功后按提示：允许通知 → 把 minibot 加入电池优化白名单。
4. 之后手机会自己重连：同一 Wi-Fi 走局域网，否则走中继。电脑端撤销这台手机后，手机会回到配对页。

## 国产系统的后台保活

仅加入电池白名单在部分系统上仍不够，请再检查（名称因系统版本而异）：

- **小米 / Redmi（MIUI / HyperOS）**：设置 → 应用设置 → 应用管理 → minibot → 省电策略 → 无限制；“自启动”打开；最近任务里把 minibot 卡片下拉“锁定”。
- **华为 / 荣耀（HarmonyOS / MagicOS）**：设置 → 应用和服务 → 应用启动管理 → minibot → 关闭“自动管理”，打开“允许后台活动”“允许关联启动”。
- **OPPO / 一加（ColorOS）**：设置 → 电池 → 更多电池设置 → 优化电池使用 → minibot → 不优化；应用详情里打开“允许自启动”“允许后台运行”；最近任务里锁定。
- **vivo（OriginOS）**：设置 → 电池 → 后台高耗电 → minibot → 允许；应用详情里打开“自启动”；最近任务里锁定。
- **三星（One UI）**：设置 → 电池 → 后台使用限制 → 从“深度休眠应用”里移除 minibot。

常驻通知是前台服务的一部分，不要在系统设置里把它关掉；如果不想要后台连接，在 App 的“手机设置”里点“停止”即可（退到后台后将收不到通知）。
