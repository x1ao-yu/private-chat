# Private Chat — P5 安全加固

轻量级、基于浏览器的端到端加密（E2EE）私密聊天。P5 新增重放保护、消息完整性、E2EE 封装 `key_update`/`key_updated` 密钥轮换、协作式成员移除、硬化限流、XSS/CSP 审查。P4 隐私、P3 房间密钥、P2 E2EE、P1 最小聊天与 P0 基础已完成。

## 核心原则

- 无账号、无联系人，房间（频道）是唯一的通信单元
- 服务端仅做中继转发，加密在客户端完成（P2）
- 保持架构轻量

## 技术栈

- **前端**：Vite + Svelte 5 (runes) + TypeScript + Tailwind CSS 4 + Vitest
- **后端**：Go 1.25 + `coder/websocket` + `net/http` 标准库
- **协议**：以 `protocol/schema.json` 为单一事实来源，通过 `make generate` 生成 `frontend/src/protocol.gen.ts` / `backend/internal/protocol/gen.go`
- **Docker**：可选，`backend/Dockerfile` + `frontend/Dockerfile` + `docker-compose.yml`

## 项目结构

```
frontend/src/
  transport.ts      # 仅负责 WebSocket 生命周期与重连
  codec.ts          # 通过 protocol.gen.ts 编解码（含 key_update/key_updated）
  e2ee.ts           # AES-GCM-256，12B IV + 16B messageId + AAD v1|channelId|messageId + ReplayCache + wrapNewKey
  invite.ts         # 邀请链接 / hash 密钥解析（纯函数，P3）
  channel.svelte.ts # UI 状态（Svelte runes），重放去重 + key_updated 处理
  App.svelte        # 路由 / 和 /r/:id，内存密钥 + Rotate & share / Rotate locally
  protocol.gen.ts   # 自动生成，请勿手动编辑

backend/
  cmd/server/main.go           # 单实例，1m 过期轮询
  internal/channel/manager.go  # 内存 channel -> 连接 + EmptyTTL 10m / IdleTTL 24h + Expire + maxMembers
  internal/ws/transport.go     # WS 处理器 + 路由 + 心跳 + 限流（join/leave 20/m、send 10/s+burst+30/s/IP、maxChannels/IP 20）+ key_update 转发
  internal/ws/codec.go         # 通过 protocol.gen.go 编解码（含 key_update）
  internal/ws/limiter.go      # 固定窗口限流器
  internal/protocol/gen.go     # 自动生成

protocol/
  schema.json       # 单一事实来源
  examples/*.json

Makefile            # generate / test / build / lint
```

## 快速开始（本地，不使用 Docker）

```bash
# 1. 协议生成（修改 schema.json 后执行）
make generate

# 2. 前端
pnpm --dir frontend install
pnpm --dir frontend dev   # http://localhost:5173（会将 /ws 代理到 :8080）

# 3. 后端（另开一个终端）
go run ./backend/cmd/server  # :8080
# 或
make dev-backend

# 4. 打开 http://localhost:5173
```

## Make 命令

```bash
make generate        # 从 schema.json 重新生成 TS/Go 代码
make check-generate  # CI：校验生成的文件是否为最新
make test            # tsc + vitest + go vet + go test
make build           # vite build + go build
make lint            # tsc + go vet
```

## Docker（可选）

```bash
docker compose up --build  # 前端 :80，后端 :8080
```

## 通信协议

客户端 → 服务端：`create_channel`、`join_channel`、`leave_channel`、`send_message`、`key_update`（E2EE 封装新钥）
服务端 → 客户端：`channel_created`、`joined`、`left`、`message`、`key_updated`、`online_count`、`error`

`message.from` 是临时的连接 ID（`peer-` + 每个 WebSocket 连接 4 字节随机数，重连时重新生成，见 `backend/internal/ws/transport.go:210`）——**不是**稳定的身份标识（P6）。不持久化任何历史记录（仅中继，见 `backend/internal/channel/manager.go:11`）；重新加入不会重放历史消息。最小限度的 `rate_limited` 限流（`create 5次/分钟 每个IP+每个连接`，`send 10次/秒 每个连接`）。

`payload` 现为**密文**，格式为 `base64url(iv).base64url(messageId).base64url(ct+tag)`，其中 `12B IV` 永不重用（每条消息通过 `getRandomValues` 生成）、每条消息对应 `16B messageId`，`AAD = v1|channelId|messageId` 用于绑定房间/版本/消息。房间密钥（P3）按房间隔离，通过 Web Crypto 使用 `AES-GCM-256`，仅存于标签页内存（不可导出的 `CryptoKey` + 仅用于重组邀请链接的内存副本），永不发送到服务端。密钥仅经由邀请链接 hash `/r/{id}#k=` 传输一次，导入后立即从 URL 剥离；SPA 导航不携带密钥。导入时执行严格的 43 字符 base64url 校验；粘贴到 Join 框的裸密钥会在发起任何网络请求前被拒绝。按设计无持久化：刷新即丢钥，重新加入需重新粘贴。详见 `frontend/src/e2ee.ts:1`、`frontend/src/invite.ts:1` 与 `protocol/schema.json:61`。

## 安全说明

- **端到端加密**：`AES-GCM-256`，`12B IV` 永不重用，每条消息 `16B messageId`，`AAD v1|channelId|messageId` 绑定，房间密钥为每房间 `32B` 通过 `crypto.getRandomValues` 生成，仅存于标签页内存；P5 复用同一信封 `wrapNewKey`/`unwrapNewKey` 轮换。
- **隐私增强（P4）**：无明文持久化 —— 服务端仅中继（`backend/internal/channel/manager.go:24`），内存 `map[channelId]*channelInfo` 单实例（重启丢状态），房间过期空房 10m / 闲置 24h 通过 1m 轮询 `ExpireNow()`（`backend/cmd/server/main.go:21`），安全日志仅 `listening` + `expired N channels`，元数据最小化。
- **重放/完整性（P5）**：每房间 `ReplayCache` LRU 1000 对 `messageIdB64` 去重（`frontend/src/e2ee.ts:51`、`frontend/src/channel.svelte.ts:106`），`isValidEnvelope` 预校验 12B iv/16B mid/≥16B ct；GCM tag+AAD 保 outsider 完整性，insider 伪造需 P6 身份；XSS 载荷经 `MessageList.svelte:34,56` 文本插值安全。
- **密钥轮换/成员移除（P5）**：`key_update` → `key_updated` E2EE 封装广播（`protocol/schema.json:66`、`backend/internal/ws/transport.go:210`、`frontend/src/e2ee.ts:170`）服务端只转发；协作式剔除 = `Rotate locally` 本地轮换不广播。
- 服务端永不记录明文；服务端仅原样中继 `payload`，只能看到密文（已通过 `e2ee.test.ts` 验证）。
- `protocol/schema.json` 校验在两端强制执行
- **限流（P5）**：`create 5次/分钟 per-IP+per-conn +20次/小时 per-IP`、`join/leave 20次/分钟 per-conn`、`send/key_update 10次/秒 per-conn burst20 +30次/秒 per-IP`、`maxMembers 100`（`backend/internal/ws/limiter.go:1`），心跳 30s Ping/Pong。
- **CSP（P5）**：`frontend/index.html:8` + `frontend/nginx.conf:6` `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` + `nosniff`。
- 生产环境应使用 HTTPS/WSS 并限制 `InsecureSkipVerify`

## 路线图

P0 基础已完成，P1 最小化聊天已完成，P2 端到端加密已完成，P3 房间密钥已完成，P4 隐私已完成，P5 安全已完成 —— 详见 `ROADMAP.md`。下一步为 P6 匿名身份（身份密钥、展示身份、验证）。
