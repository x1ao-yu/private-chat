# Private Chat — P3 房间密钥

轻量级、基于浏览器的端到端加密（E2EE）私密聊天。P3 新增房间密钥：每房间独立的客户端密钥、邀请链接（`/r/{id}#k=`，导入后立即从 URL 剥离 hash）、严格密钥校验、仅存于标签页内存。P2 端到端加密、P1 最小化聊天与 P0 基础能力已完成。

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
  codec.ts          # 通过 protocol.gen.ts 编解码
  e2ee.ts           # AES-GCM-256，12B IV + 16B messageId + AAD v1|channelId|messageId
  invite.ts         # 邀请链接 / hash 密钥解析（纯函数，P3）
  channel.svelte.ts # UI 状态（Svelte runes），组合 transport+codec+e2ee（createChannel + ChannelStore）
  App.svelte        # 路由 / 和 /r/:id，房间密钥仅存内存，邀请链接 #k= 导入后即剥离
  protocol.gen.ts   # 自动生成，请勿手动编辑

backend/
  cmd/server/main.go
  internal/channel/manager.go  # 内存中的 channel -> 连接映射
  internal/ws/transport.go     # WS 处理器 + 路由 + 心跳 + 限流
  internal/ws/codec.go         # 通过 protocol.gen.go 编解码
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

客户端 → 服务端：`create_channel`、`join_channel`、`leave_channel`、`send_message`
服务端 → 客户端：`channel_created`、`joined`、`left`、`message`、`online_count`、`error`

`message.from` 是临时的连接 ID（`peer-` + 每个 WebSocket 连接 4 字节随机数，重连时重新生成，见 `backend/internal/ws/transport.go:210`）——**不是**稳定的身份标识（P6）。不持久化任何历史记录（仅中继，见 `backend/internal/channel/manager.go:11`）；重新加入不会重放历史消息。最小限度的 `rate_limited` 限流（`create 5次/分钟 每个IP+每个连接`，`send 10次/秒 每个连接`）。

`payload` 现为**密文**，格式为 `base64url(iv).base64url(messageId).base64url(ct+tag)`，其中 `12B IV` 永不重用（每条消息通过 `getRandomValues` 生成）、每条消息对应 `16B messageId`，`AAD = v1|channelId|messageId` 用于绑定房间/版本/消息。房间密钥（P3）按房间隔离，通过 Web Crypto 使用 `AES-GCM-256`，仅存于标签页内存（不可导出的 `CryptoKey` + 仅用于重组邀请链接的内存副本），永不发送到服务端。密钥仅经由邀请链接 hash `/r/{id}#k=` 传输一次，导入后立即从 URL 剥离；SPA 导航不携带密钥。导入时执行严格的 43 字符 base64url 校验；粘贴到 Join 框的裸密钥会在发起任何网络请求前被拒绝。按设计无持久化：刷新即丢钥，重新加入需重新粘贴。详见 `frontend/src/e2ee.ts:1`、`frontend/src/invite.ts:1` 与 `protocol/schema.json:61`。

## 安全说明

- **端到端加密**：`AES-GCM-256`，`12B IV` 永不重用，每条消息 `16B messageId`，`AAD v1|channelId|messageId` 绑定，房间密钥为每房间 `32B` 通过 `crypto.getRandomValues` 生成，仅存于标签页内存，非永久（P5 轮换）；密钥仅经邀请链接 hash `#k=` 传输一次，导入后即剥离，永不发送到服务端；导入时严格校验 43 字符 base64url。
- 服务端永不记录明文；服务端仅原样中继 `payload`，只能看到密文（已通过 `e2ee.test.ts` 验证）。
- `protocol/schema.json` 校验在两端强制执行（Go 端 go-jsonschema UnmarshalJSON + TS 端 codec）
- `from` 为按连接隔离，非身份标识；按设计不持久化历史记录
- 最小限流：`create 5次/分钟`，`send 10次/秒`（`backend/internal/ws/limiter.go:1`），心跳 30 秒 Ping/Pong（`backend/internal/ws/transport.go:49`）
- 生产环境应使用 HTTPS/WSS 并限制 `InsecureSkipVerify`

## 路线图

P0 基础已完成，P1 最小化聊天已完成，P2 端到端加密已完成，P3 房间密钥已完成 —— 详见 `ROADMAP.md`。下一步为 P4 隐私（无明文持久化、内存态房间、房间过期、安全日志、元数据审查）。
