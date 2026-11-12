# 发版说明

版本号单一来源是根 `package.json` 的 `version`。桌面端与安卓端共用：

- 桌面端：`node scripts/sync-version.mjs` 把根版本写入 `apps/desktop/package.json` 与 `apps/mobile/package.json`（electron-builder 用它命名 `minibot-setup-X.Y.Z.exe` 与 `latest.yml`）。
- 安卓端：`apps/mobile/android/app/build.gradle` 直接读根 `package.json` 计算
  - `versionName` = `X.Y.Z`
  - `versionCode` = `major*10000 + minor*100 + patch`（0.1.0 → 100）

## 发版步骤

1. 改根 `package.json` 的 `version`，提交。
2. 打附注标签，标签注释就是 Release 正文：
   ```bash
   git tag -a vX.Y.Z -m "更新说明……"
   git push origin vX.Y.Z
   ```
3. GitHub Actions（`.github/workflows/release.yml`）自动构建。标签去掉可选 `-rc.N` 后缀后必须等于根版本，否则第一步直接失败。
4. 两个构建作业（Windows 安装包、安卓 APK）都成功后，最后一个作业把草稿 Release 发布；任一失败则 Release 保持草稿，客户端看不到。
5. 带 `-rc.N` 的标签发布为 prerelease：`releases/latest` 与 electron-updater 默认都忽略 prerelease，正式用户不会收到。

一个 Release 必须同时包含：`minibot-setup-X.Y.Z.exe`、`minibot-setup-X.Y.Z.exe.blockmap`、`latest.yml`、`minibot-X.Y.Z.apk`、`minibot-X.Y.Z.apk.sha256`。

## 需要的 Secrets / Variables

| 名称 | 类型 | 用途 |
| --- | --- | --- |
| `MINIBOT_COLLECT_URL` | Variable | 构建时注入两端的诊断收集点地址；为空则上传与反馈整体关闭 |
| `MINIBOT_KEYSTORE_BASE64` | Secret | 安卓签名 keystore（base64），只在 CI 里还原到 `$RUNNER_TEMP` |
| `MINIBOT_KEYSTORE_PASSWORD` | Secret | keystore 口令 |
| `MINIBOT_KEY_ALIAS` | Secret | 密钥别名 |
| `MINIBOT_KEY_PASSWORD` | Secret | 密钥口令 |

`GH_TOKEN` 用内置的 `GITHUB_TOKEN`（workflow 已声明 `contents: write`）。

## 签名约束

安卓签名密钥**不能更换**：换了之后用户无法覆盖安装，只能卸载重装并丢失数据。keystore 文件与口令不入库（`.gitignore` 已忽略 `*.jks`、`*.keystore`），本地构建时用同样的四个 `MINIBOT_KEYSTORE*` 环境变量（见 `apps/mobile/README.md`）。

## 更新链路

- 桌面端：electron-updater（provider: github），启动 1 分钟后检查、之后每 6 小时；`autoDownload`，下载完成后提示重启。未打包运行不检查。
- 安卓端：每天最多一次查 `https://api.github.com/repos/JiaMingWang-CN/minibot/releases/latest`（手动检查不限），比较 `versionCode`；下载到缓存目录、校验大小与 SHA-256 后经 FileProvider 调起系统安装。
- 端到端验收（旧版自动升级到新版）依赖公开仓库，在仓库公开后做：装 0.1.x 正式版 → 发 0.1.(x+1) → 桌面端 1 分钟内出现“已就绪”提示，手机端应用内更新且数据保留。
