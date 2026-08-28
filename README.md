# Private Chat — P2 E2EE

Lightweight browser-based E2EE private chat. P2 implements E2EE: client-side AES-GCM-256 with 12B IV + 16B messageId + AAD, server sees ciphertext only. P1 minimal chat and P0 foundation already done.

## Principles

- No account, no contacts, rooms (channels) are the only unit
- Server relays only, encryption client-side (P2)
- Keep architecture lightweight

## Stack

- **Frontend**: Vite + Svelte 5 (runes) + TypeScript + Tailwind CSS 4 + Vitest
- **Backend**: Go 1.25 + `coder/websocket` + `net/http` stdlib
- **Protocol**: `protocol/schema.json` single source → `frontend/src/protocol.gen.ts` / `backend/internal/protocol/gen.go` via `make generate`
- **Docker**: optional, `backend/Dockerfile` + `frontend/Dockerfile` + `docker-compose.yml`

## Structure

```
frontend/src/
  transport.ts      # WebSocket lifecycle only + reconnect
  codec.ts          # encode/decode via protocol.gen.ts
  e2ee.ts           # AES-GCM-256, 12B IV + 16B messageId + AAD v1|channelId|messageId
  channel.svelte.ts # UI state (Svelte runes), composes transport+codec+e2ee (createChannel + ChannelStore)
  App.svelte        # routes / and /r/:id, key in hash #k=, per-room Crypto
  protocol.gen.ts   # generated, do not edit

backend/
  cmd/server/main.go
  internal/channel/manager.go  # in-memory channel -> conns
  internal/ws/transport.go     # WS handler + routing + heartbeat + rate limit
  internal/ws/codec.go         # Decode/Encode via protocol.gen.go
  internal/ws/limiter.go      # fixed-window rate limiter
  internal/protocol/gen.go     # generated

protocol/
  schema.json       # single source of truth
  examples/*.json

Makefile            # generate / test / build / lint
```

## Quick Start (local, without Docker)

```bash
# 1. protocol generate (after editing schema.json)
make generate

# 2. frontend
pnpm --dir frontend install
pnpm --dir frontend dev   # http://localhost:5173 (proxies /ws to :8080)

# 3. backend (in another shell)
go run ./backend/cmd/server  # :8080
# or
make dev-backend

# 4. open http://localhost:5173
```

## Make

```bash
make generate        # regenerate TS/Go from schema.json
make check-generate  # CI: verify generated files are up-to-date
make test            # tsc + vitest + go vet + go test
make build           # vite build + go build
make lint            # tsc + go vet
```

## Docker (optional)

```bash
docker compose up --build  # frontend :80, backend :8080
```

## Protocol

Client → Server: `create_channel`, `join_channel`, `leave_channel`, `send_message`
Server → Client: `channel_created`, `joined`, `left`, `message`, `online_count`, `error`

`message.from` is an ephemeral connection ID (`peer-` + 4B random per WebSocket, regenerated on reconnect, `backend/internal/ws/transport.go:210`) — **not** a stable identity (P6). No history is persisted (relay-only, `backend/internal/channel/manager.go:11`); rejoin does not replay. Minimal `rate_limited` (`create 5/min per-IP+per-conn`, `send 10/s per-conn`).

`payload` is now **ciphertext** `base64url(iv).base64url(messageId).base64url(ct+tag)` with `12B IV` never reused (`getRandomValues` per message) and `16B messageId` per message, `AAD = v1|channelId|messageId` binding room/version/message. Room key is per-room, ephemeral in memory, `AES-GCM-256` via Web Crypto, never sent to server (key in hash `#k=`). See `frontend/src/e2ee.ts:1` and `protocol/schema.json:61`.

## Security Notes

- **E2EE**: `AES-GCM-256` with `12B IV` never reused, `16B messageId` per message, `AAD v1|channelId|messageId` binding, room key `32B` `crypto.getRandomValues` per room, in-memory only, not permanent (P5 rotation), key never sent to server (hash `#k=`).
- Plaintext never logged server-side; server relays `payload` verbatim and sees ciphertext only (verified via `e2ee.test.ts`).
- `protocol/schema.json` validation enforced both sides (go-jsonschema UnmarshalJSON + TS codec)
- `from` is per-connection, not identity; no history persistence by design
- Minimal rate limiting: `create 5/min`, `send 10/s` (`backend/internal/ws/limiter.go:1`), heartbeat 30s Ping/Pong (`backend/internal/ws/transport.go:49`)
- Production should use HTTPS/WSS and restrict `InsecureSkipVerify`

## Roadmap

P0 Foundation done, P1 Minimal Chat done, P2 E2EE done — see `ROADMAP.md`. Next is P3 Room Keys (invite link, key validation).
