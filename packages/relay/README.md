# minibot 中继

手机和电脑都主动连到这台中继，中继按路由 ID 把两边接起来，**只转发加密后的小块数据**，看不到聊天内容。转发时它不落盘，也不打印任何负载（可选的诊断收集见下文，默认关闭）。

## 部署

1. 服务器上安装 Node 24。
2. 取得代码后构建：

   ```bash
   npm install
   npm run build --workspace @minibot/relay
   ```

3. 直接运行：

   ```bash
   RELAY_TOKEN='至少16个字符的随机口令' node packages/relay/dist/main.js
   ```

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RELAY_TOKEN` | 无（必填） | 连接口令，至少 16 个字符；缺失或太短会直接退出 |
| `RELAY_HOST` | `127.0.0.1` | 监听地址 |
| `RELAY_PORT` | `8787` | 监听端口 |
| `RELAY_COLLECT_DB` | 不设 | 设置后启用诊断收集，值为 SQLite 文件路径，见下文「诊断收集（可选）」 |
| `RELAY_COLLECT_MAX_MB` | `2048` | 收集库的大小上限（MB），达到后返回 `507` |
| `RELAY_TRUST_PROXY` | 不设 | 设为 `1` 时，来自本机反代的连接按 `X-Forwarded-For` 里的真实地址限流。用 Caddy 等反代时必须打开，否则所有客户端共用一个限流额度 |

同一个口令要填进电脑端「设置 → 手机」的中继口令。

## 诊断收集（可选）

默认关闭：不设 `RELAY_COLLECT_DB` 时，`/collect/*` 一律返回 `404`，也不会创建任何文件，其余 HTTP 与 WebSocket 行为与之前完全一致。

设置后，中继在同一端口多提供两个接口，写入 `RELAY_COLLECT_DB` 指向的 SQLite 文件（`RELAY_COLLECT_MAX_MB` 限制大小）：

- `POST /collect/v1/events`：客户端上传的匿名事件。服务端强制白名单，任一不合规整批返回 `400`：
  - `kind` 只能是 `start` / `error` / `crash` / `metric` / `update`；`name` 匹配 `^[a-z0-9._/-]{1,64}$`；`ts` 是有限数字。
  - `data` 是扁平对象，键匹配 `^[A-Za-z0-9._-]{1,64}$`，值只能是 string（至多 64 字、无控制字符）、有限 number、boolean 或 null；序列化后不超过 4096 字符。
  - `installId`（至多 64）、`appVersion`（至多 32）、`os`（至多 64）为无控制字符的非空字符串，`platform` 只能是 `win32` 或 `android`。
- `POST /collect/v1/feedback`：用户主动提交的反馈：`description`（至多 5000 字，允许换行）、可选 `contact`（至多 200 字）、可选脱敏日志 `logs`（字符串）。

两个接口都接受 `Content-Encoding: gzip`（其他编码返回 `400`）。大小：events 原始 ≤ 256 KB、解压后 ≤ 1 MB、≤ 200 条；feedback 原始 ≤ 2 MB、解压后 ≤ 8 MB。

状态码：成功 `204`；格式错误 `400`；超限 `413`；限流 `429`；存储满 `507`；内部错误 `500`；收集路径并发超过 64 或收集模块已关闭 `503`。读请求体超过 30 秒会直接断开连接。

限流：每 IP 每分钟 events 30 次、feedback 3 次；每个 installId 每天 feedback 20 条；另有全局（不分 IP）写入上限，events 与 feedback 合计每分钟最多 20 MB（按解压后字节计），超过返回 `429`。用 Caddy 等反代时同样需要 `RELAY_TRUST_PROXY=1`。

收集路径出错不会影响 WebSocket 转发；中继日志只打印条数与错误，不打印收集的内容。

### 库满后的清理

库达到 `RELAY_COLLECT_MAX_MB` 后新请求返回 `507`。中继**不会自动删除**旧数据，需要人工清理，例如先停写入（或直接在线执行，SQLite 会串行化），再删除 90 天前的事件并回收空间：

```bash
sqlite3 /var/lib/minibot/collect.db "DELETE FROM events WHERE received_at < (strftime('%s','now') - 90*86400) * 1000; VACUUM;"
```

反馈同理（`DELETE FROM feedback WHERE id = 12;`）。`received_at` 是毫秒时间戳。

用 Caddy 时把 `/collect/*` 和 `/v1` 一起反代到中继即可。

查询（在服务器上执行，`--db` 可省略，改读 `RELAY_COLLECT_DB`）：

```bash
node packages/relay/dist/query.js events --db /var/lib/minibot/collect.db            # 最近 7 天，按版本和事件名计数
node packages/relay/dist/query.js events --days 30 --kind crash                      # 指定天数与事件类型（也可用 --name 按事件名）
node packages/relay/dist/query.js feedback --limit 50                                # 最近的反馈列表
node packages/relay/dist/query.js feedback-show 12                                   # 单条反馈全文（含日志）
node packages/relay/dist/query.js install <installId>                                # 某个安装的事件与反馈
```

## 用 systemd 常驻

`/etc/systemd/system/minibot-relay.service`：

```ini
[Unit]
Description=minibot relay
After=network.target

[Service]
Environment=RELAY_TOKEN=换成你的口令
Environment=RELAY_HOST=127.0.0.1
Environment=RELAY_PORT=8787
Environment=RELAY_TRUST_PROXY=1
WorkingDirectory=/opt/minibot
ExecStart=/usr/bin/node packages/relay/dist/main.js
Restart=always
RestartSec=3
User=minibot
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now minibot-relay
```

## 用 Caddy 提供 wss://

中继保持默认只监听 `127.0.0.1`，由 Caddy 反向代理并自动签发证书，见 `Caddyfile.example`。同时设置 `RELAY_TRUST_PROXY=1`，让限流按真实客户端地址计算。电脑端和手机端填：`wss://你的域名/v1`。

## 关于 ws://

直接用 `ws://`（不经 TLS）时，聊天内容仍是端到端加密的，但网络上的人能看到连接时间、对象和数据量等元数据。只在可信网络里这样用，在外面请用 `wss://`。

## 电脑身份

口令写在配对二维码里，手机也知道，所以它只用来挡住没有口令的陌生人，不能用来认定"谁是这台电脑"。电脑连上中继时还要证明自己持有路由对应的私钥：中继发一个一次性挑战，电脑用私钥回答，中继核对通过才接纳。即使拿到口令和电脑公钥，没有私钥也无法冒充电脑、把它顶下线。

## 限制

- 单帧不超过 67584 字节，超出以 `4413` 关闭。
- 每个路由最多 8 个手机会话，超出以 `4429` 拒绝。
- 每个 IP 每 60 秒最多 30 次新连接（反代后面需设 `RELAY_TRUST_PROXY=1`）。
- 关闭码：`4400` hello 或身份证明不合法、5 秒内未完成、`4401` 口令错误、`4403` 电脑身份验证失败、`4409` 被同一身份的新电脑连接顶替、`4413` 帧过大、`4429` 限流。
