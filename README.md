# Private Chat — P1 Minimal Chat

Lightweight browser-based E2EE private chat. P1 implements minimal chat: create/join/leave, message relay, reconnect, online count. P0 foundation already done.

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
  transport.ts      # WebSocket lifecycle only
  codec.ts          # encode/decode via protocol.gen.ts
  e2ee.ts           # noop until P2
  channel.svelte.ts # UI state (Svelte runes), composes transport+codec+e2ee
  App.svelte        # routes / and /r/:id
  protocol.gen.ts   # generated, do not edit

backend/
  cmd/server/main.go
  internal/channel/manager.go  # in-memory channel -> conns
  internal/ws/transport.go     # WS handler + routing
  internal/ws/codec.go         # Decode/Encode via protocol.gen.go
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

P0 `payload` is plaintext; P2 will be ciphertext. See `protocol/schema.json` and `protocol/README.md`.

## Security Notes

- Plaintext never logged server-side
- `protocol/schema.json` validation enforced both sides (go-jsonschema UnmarshalJSON + TS codec)
- Production should use HTTPS/WSS and restrict `InsecureSkipVerify`

## Roadmap

P0 Foundation done, P1 Minimal Chat done — see `ROADMAP.md`. Next is P2 E2EE.
