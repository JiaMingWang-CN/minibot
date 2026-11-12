# minibot 中继

手机和电脑都主动连到这台中继，中继按路由 ID 把两边接起来，**只转发加密后的小块数据**，看不到聊天内容。它不落盘，也不打印任何负载。

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
| `RELAY_TRUST_PROXY` | 不设 | 设为 `1` 时，来自本机反代的连接按 `X-Forwarded-For` 里的真实地址限流。用 Caddy 等反代时必须打开，否则所有客户端共用一个限流额度 |

同一个口令要填进电脑端「设置 → 手机」的中继口令。

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

## 限制

- 单帧不超过 67584 字节，超出以 `4413` 关闭。
- 每个路由最多 8 个手机会话，超出以 `4429` 拒绝。
- 每个 IP 每 60 秒最多 30 次新连接（反代后面需设 `RELAY_TRUST_PROXY=1`）。
- 关闭码：`4400` hello 不合法或 5 秒内未发 hello、`4401` 口令错误、`4409` 被新的电脑连接顶替、`4413` 帧过大、`4429` 限流。
