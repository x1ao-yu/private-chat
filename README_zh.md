# Private Chat

轻量级、基于浏览器的端到端加密（E2EE）私密聊天：房间是唯一的通信单元，服务端只转发密文。每个会话携带一份按房间独立的身份——每房间一对全新 Ed25519 密钥（仅内存保存，跨房间不可关联）、基于 `identity-v2` 编码的签名聊天消息与昵称声明、接收端逐条验签 + 每房间 TOFU 固定 + key-change 警告 + 未签名消息显式"no identity"标记。P0–P6（基础、最小化聊天、E2EE、房间密钥、隐私、安全加固、会话身份）已完成。P7 以"评估并暂缓"收口：未引入 MLS，也不声称具备前向保密/事后保密（PCS）能力。P9 进行中——移动端体验、部署硬化，以及滥用防护中此前只在纸面上成立的部分（真正生效的按 IP 限流、成员上限、WS Origin 校验）已交付。

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
  identity.ts       # P6 会话身份：Ed25519 密钥对、指纹、签名消息/昵称的封装与验签（identity-v2 长度前缀编码）
  invite.ts         # 邀请链接 / hash 密钥解析（纯函数，P3）
  channel.svelte.ts # UI 状态（Svelte runes），重放去重 + key_updated 处理 + 身份验签（TOFU）
  App.svelte        # 路由 / 和 /r/:id，内存密钥 + 会话身份 + Rotate & share / Rotate locally
  *.test.ts         # Vitest 测试套件：e2ee / identity / channel / transport / codec / invite / app（含 App.svelte 组件测试）
  protocol.gen.ts   # 自动生成，请勿手动编辑

backend/
  cmd/server/main.go           # 单实例，1m 过期轮询（同时回收已过期的限流窗口）
  internal/channel/manager.go  # 内存 channel -> 连接 + EmptyTTL 10m / IdleTTL 24h + Expire + JoinIfRoom（容量检查与写入同一次加锁完成，maxMembers 100）
  internal/ws/transport.go     # WS 处理器（默认同源 Origin 校验）+ 路由 + 心跳 + 限流（create 5/m 每IP+每连接 + 20/h 每IP、join/leave 20/m 每连接、send 10/s 每连接 + 30/s 每IP）+ key_update 转发
  internal/ws/codec.go         # 通过 protocol.gen.go 编解码（含 key_update）
  internal/ws/limiter.go       # 固定窗口限流器（每个窗口自带时长）
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
make test            # tsc + vitest + go vet + go test -race
make lint            # gofmt 检查 + go vet + tsc
make fmt             # 用 gofmt 就地格式化 Go 源码
make build           # vite build + go build
```

## 测试与 CI

`make test` 依次执行 `tsc`、Vitest（7 套件：单元测试 + 使用 Svelte 原生
`mount()` 的 `App.svelte` 组件级测试——覆盖 hash 密钥剥离、发起任何网络请求
前拦截裸密钥、轮换、导航与表单）、`go vet` 与 `go test -race`。

CI（`.github/workflows/ci.yml`）对每次推送设门禁：`check-generate` →
`lint` → `test -race` → `build`，外加 docker compose 构建冒烟。依赖扫描是
**门禁而非 advisory**：`pnpm audit --prod`（仅运行时依赖）与
`govulncheck@v1.7.0`（钉版本；漏洞库实时更新）必须均为零发现——新公开的
CVE 会把 `main` 跑红，直到升级依赖或 Go 工具链补丁。

## 部署

```bash
docker compose up --build --detach   # nginx :80 → 静态资源 + /ws + /health 代理
```

- **运行形态**:前端容器以非特权 nginx 提供构建产物(容器内 8080,对外映射 80),并将 `/ws`、`/health` 代理到 backend;backend **仅存在于 compose 内网**(不发布端口,如需临时调试可在 backend 下加 `"8080:8080"`)。两服务均配置 `restart: unless-stopped` 与镜像健康检查,前端等待 backend 健康后启动。
- **TLS / wss**:由**你自己的**外层反向代理 / 负载均衡终结——将其指向 80 端口并提供 HTTPS 即可,前端按页面协议自动使用 `wss://`。容器内有意不设置 HSTS,请在 TLS 边缘开启。
- **缓存**:带哈希的 `/assets/*` 设置 `immutable`(一年);`index.html` 为 `no-cache`,保证新版本立即生效。
- **按设计无持久化**:backend 重启即丢弃所有房间(P4)。
- **WS Origin 校验**:已默认强制执行。`backend/internal/ws/transport.go` 调用 `websocket.Accept(w, r, nil)`,由库自带的默认同源检查(请求 `Origin` 对比 `Host`)拒绝跨站握手。这里有意**不引入**任何 Origin 配置面:浏览器连接的就是自身源,因此默认拓扑开箱即用;确有跨域需求时,必须自行修改 Go 源码加入 `OriginPatterns`。`frontend/nginx.conf` 转发保留端口的原始 Host(`proxy_set_header Host $http_host`)——nginx 的 `$host` 会丢弃端口而浏览器 `Origin` 含端口,站点跑在非标准端口时同源检查会静默失败握手;你自建的反向代理同样必须保留端口。
- **限流使用的客户端地址(`TRUST_PROXY_XFF`)**:默认按 TCP 对端地址计数,因此在反向代理之后所有客户端会共用同一个桶。`TRUST_PROXY_XFF=true` 时改为取 `X-Forwarded-For` 的**最右**一项——该项由可信代理追加、客户端无法覆写(最左一项**是**客户端可控的,信任它等于让客户端自己挑选限流桶)。只有当 backend 仅能通过会追加该头的反向代理访问时才开启;backend 可被直连时必须保持关闭。缺失、格式非法或无法解析的值回落为对端地址。仓库内的 `docker-compose.yml` 已为 backend 设置该变量,因为 nginx 是它的唯一入口。这是后端唯一的环境变量。

## 通信协议

客户端 → 服务端：`create_channel`、`join_channel`、`leave_channel`、`send_message`、`key_update`（E2EE 封装新钥）
服务端 → 客户端：`channel_created`、`joined`、`left`、`message`、`key_updated`、`online_count`、`error`

`message.from` 是临时的连接 ID（`peer-` + 每个 WebSocket 连接 4 字节随机数，重连时重新生成，见 `backend/internal/ws/transport.go`）——**不是**稳定的身份标识。自 P6 起，发送者归属由加密载荷内的 Ed25519 会话身份提供。不持久化任何历史记录（仅中继，见 `backend/internal/channel/manager.go`）；重新加入不会重放历史消息。超出限额返回 `error rate_limited`；当前完整限额见"安全说明 → 限流"。

`payload` 现为**密文**，格式为 `base64url(iv).base64url(messageId).base64url(ct+tag)`，其中 `12B IV` 永不重用（每条消息通过 `getRandomValues` 生成）、每条消息对应 `16B messageId`，`AAD = v1|channelId|messageId` 用于绑定房间/版本/消息。房间密钥（P3）按房间隔离，通过 Web Crypto 使用 `AES-GCM-256`，仅存于标签页内存（从邀请导入的密钥不可导出；新生成的密钥之所以可导出，仅仅是为了把它一次性写进邀请链接），另有一份内存副本专用于重组邀请链接，永不发送到服务端。密钥仅经由邀请链接 hash `/r/{id}#k=` 传输一次，导入后立即从 URL 剥离；SPA 导航不携带密钥。导入时执行严格的 43 字符 base64url 校验；粘贴到 Join 框的裸密钥会在发起任何网络请求前被拒绝。按设计无持久化：刷新即丢钥，重新加入需重新粘贴。详见 `frontend/src/e2ee.ts`、`frontend/src/invite.ts` 与 `protocol/schema.json`。

**P6 身份完全位于加密载荷内部**（服务端与协议零改动，线上信封格式与协议 schema 均未改变）：聊天消息明文内层为 JSON `{t:"msg",v:2,text,nick,pk,sig}`，昵称更新为 `{t:"nick",v:1,nick,pk,sig}`——昵称内层有意保留 `v:1`，因为它的接收端解析器与未签名昵称声明共用；只有签名消息载荷升到 `v:2`。消息签名覆盖 `identity-v2|msg|channelId|messageIdB64|<字节长度>:nick|<字节长度>:text`；昵称声明签名覆盖 `identity-v2|nick|channelId|<字节长度>:nick`。用户可控字段以其 UTF-8 字节长度作前缀，两类载荷再各带 `msg` / `nick` 域分离标签，使被签名的字符串成为单射。`identity-v1` 并不如此：它用裸 `|` 拼接字段，而昵称本身允许包含 `|`，于是 `nick="Alice", text="meet at 9|room 3"` 与 `nick="Alice|meet at 9", text="room 3"` 会产生完全相同的签名字符串，任何持有房间密钥的人都能把他人合法的 Ed25519 签名重新解释成另一组（昵称, 文本）；更糟的是 TOFU 层还会把伪造的昵称当作干净验签结果固定下来。v1 签名声明如今会被识别出来且绝不再被视为已验证：UI 显示 `⚠️ stale signature — refresh to upgrade`，而不是静默丢弃消息或污染固定表。接收端逐条验签（每房间 TOFU 固定，标签页内存），签名无效则隐藏内容；昵称被不同指纹声称（key-change）时在气泡上打琥珀色冲突徽章，并按（昵称,新指纹）去重发出一次系统提示；同一连接出现两个不同身份会触发连接级错误。来自未知客户端版本的结构化内层载荷直接忽略，绝不渲染原始 JSON。未签名消息显式显示灰色"no identity"徽章；浏览器不支持 Ed25519 时房间头部显示"identity auth unavailable"（不静默降级）。昵称规则为去除首尾空白后 1–20 字符、不含换行，`|` **允许**使用——正是 v2 的长度前缀编码让这一点变得安全。明文预算在加密前收口为 `MAX_INNER_UTF8 = 6098` 字节（`codec.ts`），线上 8192 上限不变。详见 `frontend/src/identity.ts` 与 SECURITY.md "P6 Notes"（边界：仅 TOFU、假名而非匿名、按设计仅限本会话）。

## 安全说明

- **端到端加密**：`AES-GCM-256`，`12B IV` 永不重用，每条消息 `16B messageId`，`AAD v1|channelId|messageId` 绑定，房间密钥为每房间 `32B` 通过 `crypto.getRandomValues` 生成，仅存于标签页内存；P5 复用同一信封 `wrapNewKey`/`unwrapNewKey` 轮换。
- **隐私增强（P4）**：无明文持久化 —— 服务端仅中继（`backend/internal/channel/manager.go`），内存 `map[channelId]*channelInfo` 单实例（重启丢状态），房间过期空房 10m / 闲置 24h 通过 1m 轮询 `ExpireNow()`（`backend/cmd/server/main.go`），安全日志仅 `listening`、`expired N channels`（只报数量）与停机相关行，不含 payload/peer-id/IP，元数据最小化（IP 仅作为限流键存在：1 分钟窗口，另有 1 小时的建房预算，窗口到期即回收，且永不写入日志）。
- **重放/完整性（P5）**：每房间 `ReplayCache` 有界 FIFO 去重（每频道 1000 条，按插入序淘汰）对 `messageIdB64` 去重（`frontend/src/e2ee.ts`、`frontend/src/channel.svelte.ts`），`isValidEnvelope` 预校验 12B iv/16B mid/≥16B ct；GCM tag+AAD 保 outsider 完整性；XSS 载荷经 `MessageList.svelte` 文本插值安全。
- **会话身份（P6）**：每房间一对全新 Ed25519 密钥（仅内存保存、永不持久化、跨房间不可关联、私钥不可导出）；聊天消息与昵称更新在 E2EE 载荷内携带 `{pk,sig}`，接收端逐条验签 + 每房间 TOFU 固定（`frontend/src/identity.ts`、`frontend/src/channel.svelte.ts`）；签名无效隐藏内容（`⚠️ invalid signature`）；早于 `identity-v2` 的签名声明显示为 `⚠️ stale signature — refresh to upgrade` 且绝不固定进 TOFU 表；key-change 警告（同昵称不同指纹 → 琥珀徽章 + 按（昵称,指纹）去重的一次性系统消息；同一连接两个身份 → 错误）；未签名消息显示灰色"no identity"徽章；浏览器不支持时房间头部显式"identity auth unavailable"徽章。头像颜色改用稳定的身份指纹。昵称规则：去除首尾空白后 1–20 字符、不含换行，允许出现 `|`。边界：仅 TOFU、无 PKI/带外验证；假名而非匿名（刷新/离开重进会产生新的房间会话身份）；持有房间密钥者无法再伪造签名内容——但这一性质**自 identity-v2 起**才成立，v1 编码用裸 `|` 拼接字段，可在 nick/text 边界处被重切，故 v1 签名不再被当作已验证；未签名的旧版声明仍可伪造——详见 SECURITY.md "P6 Notes"。
- **密钥轮换/成员移除（P5）**：`key_update` → `key_updated` E2EE 封装广播（`protocol/schema.json`、`backend/internal/ws/transport.go`、`frontend/src/e2ee.ts`）服务端只转发；协作式剔除 = `Rotate locally` 本地轮换不广播。
- 服务端永不记录明文；服务端仅原样中继 `payload`，只能看到密文。该性质是**结构性的**——`send_message.payload` 是唯一的内容字段，而中继把它当作不透明字节处理——`backend/internal/ws/transport_test.go` 证明 payload 未经解析即逐字节转发。`e2ee.test.ts` 覆盖的是客户端信封（往返、篡改、AAD 绑定），不涉及服务端。
- `protocol/schema.json` 校验在两端强制执行
- `from` 是按连接生成的临时标识，不是身份；按设计不持久化历史记录
- **限流（P5，P9 滥用防护修复后才真正生效）**：纯粹的**固定窗口计数器**——没有令牌桶，也没有 burst 参数（`create 5次/分钟 per-IP + 5次/分钟 per-conn + 20次/小时 per-IP`、`join/leave 20次/分钟 per-conn`、`send/key_update/set_room_name/set_nickname 10次/秒 per-conn + 30次/秒 per-IP`、`maxMembers 100`）（`backend/internal/ws/limiter.go`、`backend/internal/ws/transport.go`、`backend/internal/channel/manager.go`）。持续发送时一个墙钟秒内最多可能放行接近 20 条，那只是 10/s 窗口跨越边界时的最坏涌现结果，并非配置的突发额度。每个窗口自带时长并由 1m 轮询回收，每小时建房预算不再每分钟被清空。只有在可信反向代理后开启 `TRUST_PROXY_XFF` 时，按 IP 的计数才落到真实客户端地址（见"部署"小节），否则按 TCP 对端地址计数。成员上限现在在同一次加锁内完成检查与写入，并发加入无法再集体突破上限。心跳 30s Ping/Pong（`backend/internal/ws/transport.go`）。
- **CSP（P5）**，分两层：`frontend/index.html` 的 `<meta>` CSP 为 `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'`（不含 `frame-ancestors`——该指令只在 HTTP 头中有效）；`frontend/nginx.conf` 另行添加仅限 HTTP 头的 `frame-ancestors 'none'`，以及 `X-Frame-Options DENY`、`X-Content-Type-Options nosniff`、`Referrer-Policy no-referrer`。
- 生产环境应使用 HTTPS/WSS；WS Origin 校验已由库的默认同源检查强制生效，且没有任何配置项可以放松它——跨域部署必须自行在 Go 源码中添加 `OriginPatterns`

## 路线图

P0 基础已完成，P1 最小化聊天已完成，P2 端到端加密已完成，P3 房间密钥已完成，P4 隐私已完成，P5 安全已完成，P6 匿名身份已完成。P7：标准化群组协议评估已完成 —— MLS 引入暂缓，详见 `docs/mls-evaluation.md`（当前不声称具备 FS/PCS，见 SECURITY.md "P7 Notes"）。P9 已部分落地：移动端体验、部署硬化，以及此前 P5 只在纸面上声称的滥用防护控制（真正生效的按 IP 限流、成员上限、WS Origin 校验）；内容审核/举报工具、PWA 与性能优化尚未开始。
