# Private Chat — P3 Room Keys

Lightweight browser-based E2EE private chat. P3 adds room keys: per-room client-side secrets, invite links (`/r/{id}#k=`) whose hash is stripped right after import, strict key validation, tab-memory-only storage. P2 E2EE, P1 minimal chat and P0 foundation already done.

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
  invite.ts         # invite-link / hash-key parsing (pure functions, P3)
  channel.svelte.ts # UI state (Svelte runes), composes transport+codec+e2ee (createChannel + ChannelStore)
  App.svelte        # routes / and /r/:id, in-memory room keys, invite hash #k= stripped after import
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

`payload` is now **ciphertext** `base64url(iv).base64url(messageId).base64url(ct+tag)` with `12B IV` never reused (`getRandomValues` per message) and `16B messageId` per message, `AAD = v1|channelId|messageId` binding room/version/message. Room key (P3) is per-room, `AES-GCM-256` via Web Crypto, held in tab memory only (non-extractable `CryptoKey` + an in-memory copy used solely to rebuild invite links), never sent to server. It travels only inside the invite-link hash `/r/{id}#k=`, which is stripped from the URL as soon as it is imported; SPA navigation never carries it. Import validates strict 43-char base64url; a bare key pasted into Join is rejected before any network request. No persistence by design: a refresh drops the key, rejoining requires re-pasting. See `frontend/src/e2ee.ts:1`, `frontend/src/invite.ts:1` and `protocol/schema.json:61`.

## Security Notes

- **E2EE**: `AES-GCM-256` with `12B IV` never reused, `16B messageId` per message, `AAD v1|channelId|messageId` binding, room key `32B` `crypto.getRandomValues` per room, tab-memory only, not permanent (P5 rotation); key travels once via invite hash `#k=` and is stripped after import, never sent to server; strict 43-char base64url validation on import.
- Plaintext never logged server-side; server relays `payload` verbatim and sees ciphertext only (verified via `e2ee.test.ts`).
- `protocol/schema.json` validation enforced both sides (go-jsonschema UnmarshalJSON + TS codec)
- `from` is per-connection, not identity; no history persistence by design
- Minimal rate limiting: `create 5/min`, `send 10/s` (`backend/internal/ws/limiter.go:1`), heartbeat 30s Ping/Pong (`backend/internal/ws/transport.go:49`)
- Production should use HTTPS/WSS and restrict `InsecureSkipVerify`

## Roadmap

P0 Foundation done, P1 Minimal Chat done, P2 E2EE done, P3 Room Keys done — see `ROADMAP.md`. Next is P4 Privacy (no plaintext persistence, in-memory room state, room expiration, safe logging, metadata review).
