# Private Chat

Lightweight browser-based E2EE private chat: rooms are the only unit, the server relays ciphertext. A session carries a per-room identity — a fresh Ed25519 keypair per room (memory only, cross-room unlinkable), `identity-v2` signed chat messages and nickname claims, receive-side signature verification with per-room TOFU pinning, key-change warnings and explicit "no identity" marking for unsigned messages. P0–P6 (foundation, minimal chat, E2EE, room keys, privacy, security hardening, session identity) are done. P7 closed as "evaluate and defer": MLS is not adopted and no forward-secrecy / post-compromise-security property is claimed. P9 is in progress — mobile UX, deployment and the abuse-protection controls (real per-IP rate limits, member cap, WS origin verification) have landed.

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
  codec.ts          # encode/decode via protocol.gen.ts (incl. key_update/key_updated)
  e2ee.ts           # AES-GCM-256, 12B IV + 16B messageId + AAD v1|channelId|messageId + ReplayCache + wrapNewKey
  identity.ts       # P6 session identity: Ed25519 keypair, fingerprints, signed message/nick wrap+verify (identity-v2 length-prefixed framing)
  invite.ts         # invite-link / hash-key parsing (pure functions, P3)
  channel.svelte.ts # UI state (Svelte runes), replay dedup + key_updated handling + identity verify (TOFU)
  App.svelte        # routes / and /r/:id, in-memory keys + session identity + Rotate & share / Rotate locally
  protocol.gen.ts   # generated, do not edit

backend/
  cmd/server/main.go           # single-instance, 1m expiration sweep + expired limiter windows
  internal/channel/manager.go  # in-memory channel -> conns + EmptyTTL 10m / IdleTTL 24h + Expire + JoinIfRoom (cap checked and applied under one lock, maxMembers 100)
  internal/ws/transport.go     # WS handler (default same-origin check) + routing + heartbeat + rate limit (create 5/m per-IP+per-conn + 20/h per-IP, join/leave 20/m per-conn, send 10/s per-conn + 30/s per-IP) + key_update relay
  internal/ws/codec.go         # Decode/Encode via protocol.gen.go (incl. key_update)
  internal/ws/limiter.go       # fixed-window rate limiter (each window carries its own duration)
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
make test            # tsc + vitest + go vet + go test -race
make lint            # gofmt check + go vet + tsc
make fmt             # rewrite Go sources with gofmt
make build           # vite build + go build
```

## Deployment

```bash
docker compose up --build --detach   # nginx :80 → static assets + /ws + /health proxy
```

- **What runs**: the frontend container serves the built SPA on port 80 (unprivileged
  nginx, internal 8080) and proxies `/ws` and `/health` to the backend, which is **internal
  to the compose network** (no published port; temporarily add `"8080:8080"` to inspect it).
  Both services have `restart: unless-stopped` and image healthchecks; the frontend waits
  for a healthy backend.
- **TLS / wss**: terminated at **your** outer reverse proxy / load balancer — point it at
  port 80 and serve HTTPS. The app picks `wss://` automatically from the page protocol.
  HSTS is intentionally not set inside the container; enable it at your TLS edge.
- **Caching**: hashed `/assets/*` are `immutable` (1y); `index.html` is `no-cache` so new
  deploys are picked up immediately.
- **In-memory by design**: a backend restart drops all rooms (P4).
- **WS origin verification**: enforced. `backend/internal/ws/transport.go` calls
  `websocket.Accept(w, r, nil)`, so the library's default same-origin check (request `Origin`
  vs `Host`) rejects cross-site handshakes. There is deliberately **no** origin configuration
  surface: browsers connect to their own origin, so this works out of the box in the shipped
  topology. A genuinely cross-origin deployment has to add `OriginPatterns` in the Go source
  itself. `frontend/nginx.conf` forwards the original Host **including its port**
  (`proxy_set_header Host $http_host`) — nginx's `$host` drops the port while the browser's
  `Origin` keeps it, which would fail the same-origin check silently on a non-standard port;
  any proxy you put in front must preserve the port the same way.
- **Client address for rate limits (`TRUST_PROXY_XFF`)**: by default the limiter keys on the TCP
  peer address, so behind a proxy every client would share one bucket. `TRUST_PROXY_XFF=true`
  makes it key on the **right-most** entry of `X-Forwarded-For` — the one the trusted proxy
  appends and a client cannot overwrite (the left-most entry *is* client-controlled, so trusting
  it would let a client pick its own rate-limit bucket). Enable it **only** when the backend is
  exclusively reachable through a reverse proxy that appends that header; leave it unset whenever
  the backend is directly exposed. An absent, malformed or unparseable value falls back to the
  peer address. The provided `docker-compose.yml` sets it for the backend because nginx is its
  sole ingress. This is the backend's only environment variable.

## Protocol

Client → Server: `create_channel`, `join_channel`, `leave_channel`, `send_message`, `key_update` (E2EE-wrapped new key)
Server → Client: `channel_created`, `joined`, `left`, `message`, `key_updated`, `online_count`, `error`

`message.from` is an ephemeral connection ID (`peer-` + 4B random per WebSocket, regenerated on reconnect, `backend/internal/ws/transport.go`) — **not** a stable identity. Since P6, sender attribution comes from the Ed25519 session identity inside the encrypted payload. No history is persisted (relay-only, `backend/internal/channel/manager.go`); rejoin does not replay. Minimal `rate_limited` (`create 5/min per-IP+per-conn`, `send 10/s per-conn`).

`payload` is now **ciphertext** `base64url(iv).base64url(messageId).base64url(ct+tag)` with `12B IV` never reused (`getRandomValues` per message) and `16B messageId` per message, `AAD = v1|channelId|messageId` binding room/version/message. Room key (P3) is per-room, `AES-GCM-256` via Web Crypto, held in tab memory only (a key imported from an invite is non-extractable; a freshly generated one is extractable only because it must be exported once into the invite link), plus an in-memory copy used solely to rebuild invite links, never sent to server. It travels only inside the invite-link hash `/r/{id}#k=`, which is stripped from the URL as soon as it is imported; SPA navigation never carries it. Import validates strict 43-char base64url; a bare key pasted into Join is rejected before any network request. No persistence by design: a refresh drops the key, rejoining requires re-pasting. See `frontend/src/e2ee.ts`, `frontend/src/invite.ts` and `protocol/schema.json`.

**P6 identity rides inside the encrypted payload** (zero server/protocol changes; the wire envelope format and the protocol schema are unchanged): the inner plaintext of chat messages is JSON `{t:"msg",v:2,text,nick,pk,sig}` and nickname updates `{t:"nick",v:1,nick,pk,sig}` — the nick inner JSON keeps `v:1` on purpose because its receive-side parser is shared with unsigned nick claims, only the signed-message payload moved to `v:2`. Messages sign `identity-v2|msg|channelId|messageIdB64|<byteLen>:nick|<byteLen>:text`; nick claims sign `identity-v2|nick|channelId|<byteLen>:nick`. Length-prefixing the user-controlled fields with their UTF-8 byte length and tagging the two kinds with `msg` / `nick` makes the signed string injective. That was **not** true of `identity-v1`, which joined fields with a bare `|` while nicknames may contain `|`: `nick="Alice", text="meet at 9|room 3"` and `nick="Alice|meet at 9", text="room 3"` produced the identical signed string, so any holder of the room key could re-present someone else's valid Ed25519 signature as a different nickname/text pair — and the TOFU layer then pinned the forged nickname as cleanly verified. v1 signed claims are detected and never trusted as verified: the UI shows `⚠️ stale signature — refresh to upgrade` rather than silently dropping the message or poisoning the pin. Receivers verify per message (TOFU pinning per room, tab memory), hide content on invalid signatures, and warn on key changes (same nick, different fingerprint — once per contested pair as a system message, plus a connection-level mismatch error). Structured inner payloads from unknown client versions are ignored, never rendered as raw JSON. Unsigned messages are visibly marked with a "no identity" chip; if Ed25519 is unsupported the room header shows "identity auth unavailable" (no silent degradation). Nicknames are 1–20 characters after trimming, no newline, and `|` **is** allowed — the v2 length-prefix framing is what makes that safe. The plaintext budget is capped at `MAX_INNER_UTF8 = 6098` bytes before encryption (`codec.ts`); the wire limit stays 8192. See `frontend/src/identity.ts` and SECURITY.md "P6 Notes" for the exact boundaries (TOFU only, pseudonymity not anonymity, session-scoped by design).

## Security Notes

- **E2EE**: `AES-GCM-256` with `12B IV` never reused, `16B messageId` per message, `AAD v1|channelId|messageId` binding, room key `32B` `crypto.getRandomValues` per room, tab-memory only, not permanent; key travels once via invite hash `#k=` and is stripped after import, never sent to server; strict 43-char base64url validation on import. **P5**: `wrapNewKey`/`unwrapNewKey` reuses E2EE envelope to rotate.
- **Privacy (P4)**: no plaintext persistence — server relay-only (`backend/internal/channel/manager.go`), in-memory `map[channelId]*channelInfo` single-instance (restart drops state), room expiration empty 10m / idle 24h via 1m sweep `ExpireNow()` (`backend/cmd/server/main.go`), safe logging only `listening`, `expired N channels` (count) and the shutdown lines (no payload/peer-id/IP, `channelId` allowed but not logged by default), metadata minimal (channelId, ephemeral peer-id per conn, online count, IP seen only as a limiter key — 1 min windows plus a 1 h create budget, dropped when the window expires and never logged).
- **Replay/Integrity (P5)**: per-channel `ReplayCache` bounded FIFO dedup of 1000 ids on `messageIdB64` (`frontend/src/e2ee.ts`, `frontend/src/channel.svelte.ts`) drops duplicates, `isValidEnvelope` pre-validates 12B iv/16B mid/≥16B ct; GCM tag + AAD ensures outsider integrity, `MessageList.svelte` text interpolation safe (no `{@html}`), `XSS` payload stays plaintext.
- **Session identity (P6)**: fresh Ed25519 keypair **per room** (memory only, never persisted, cross-room unlinkable, non-extractable private key); chat messages and nick updates carry `{pk,sig}` inside the E2EE payload, verified per message against per-room TOFU pinning (`frontend/src/identity.ts`, `frontend/src/channel.svelte.ts`); invalid signatures hide content (`⚠️ invalid signature`), pre-`identity-v2` signed claims are surfaced as `⚠️ stale signature — refresh to upgrade` and never pinned, key changes warn (same nick/different fingerprint → amber chip + one-time system message; two identities on one connection → error), unsigned messages show a gray "no identity" chip, and an unsupported browser shows an explicit "identity auth unavailable" badge. Avatar colors use the stable identity fingerprint. Nicknames are 1–20 characters after trimming with no newline; `|` is allowed. Boundaries: TOFU only, no PKI/out-of-band verification; pseudonymity not anonymity (refresh/leave produces a new room-session identity); a room-key holder cannot re-forge signed content **as of identity-v2** — the v1 encoding joined fields with a bare `|` and was malleable across the nick/text boundary, so v1 signatures are no longer accepted as verified; unsigned legacy claims remain spoofable — see SECURITY.md "P6 Notes".
- **Key rotation / Member removal (P5)**: `key_update` → `key_updated` E2EE-wrapped broadcast (`protocol/schema.json`, `backend/internal/ws/transport.go`, `frontend/src/e2ee.ts`) server only relays; cooperative eviction = `Rotate locally` without broadcast, old members lose key.
- Plaintext never logged server-side; the server relays `payload` verbatim and sees ciphertext only. That property is **structural** — `send_message.payload` is the only content field and the relay treats it as opaque bytes — and `backend/internal/ws/transport_test.go` proves the payload is forwarded byte-for-byte without being parsed. `e2ee.test.ts` covers the client-side envelope (round-trip, tamper, AAD binding), not the server.
- `protocol/schema.json` validation enforced both sides (go-jsonschema UnmarshalJSON + TS codec)
- `from` is per-connection, not identity; no history persistence by design
- **Rate limiting (P5, effective since the P9 abuse-protection fix)**: plain **fixed-window counters** — no token bucket and no burst parameter (`create 5/min per-IP + 5/min per-conn + 20/hour per-IP`, `join/leave 20/min per-conn`, `send/key_update/set_room_name/set_nickname 10/s per-conn + 30/s per-IP`, `maxMembers 100`) (`backend/internal/ws/limiter.go`, `backend/internal/ws/transport.go`, `backend/internal/channel/manager.go`). A sustained sender can see close to 20 messages in one wall-clock second only because a 10/s window can straddle a boundary — that is the emergent worst case, not a configured burst. Each window carries its own duration and is reclaimed by the 1m sweep, so the hourly create budget is no longer wiped every minute. Per-IP keys reach the real client address only when `TRUST_PROXY_XFF` is enabled behind a trusted proxy (see Deployment); otherwise they key on the peer address. The member cap is now checked and applied in one locked step, so concurrent joins can no longer overshoot it. Heartbeat 30s Ping/Pong (`backend/internal/ws/transport.go`)
- **CSP (P5)**, split across two layers: the `<meta>` CSP in `frontend/index.html` is `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'` (no `frame-ancestors` — that directive is only valid via HTTP header); `frontend/nginx.conf` adds the HTTP-header-only directives `frame-ancestors 'none'` plus `X-Frame-Options DENY`, `X-Content-Type-Options nosniff` and `Referrer-Policy no-referrer`. No nonce needed.
- Production should use HTTPS/WSS; WS origin verification is already enforced by the library's same-origin check and there is no configuration to relax it — cross-origin clients must add `OriginPatterns` in the Go source

## Roadmap

P0 Foundation done, P1 Minimal Chat done, P2 E2EE done, P3 Room Keys done, P4 Privacy done, P5 Security done, P6 Anonymous Identity done. P7: standardized group protocols evaluated — MLS adoption deferred, see `docs/mls-evaluation.md` (no FS/PCS claims today; see SECURITY.md "P7 Notes"). P9 partially landed: mobile UX, deployment hardening, and the abuse-protection controls that P5 only claimed on paper (working per-IP limits, member cap, WS origin verification); moderation/reporting tooling, PWA and performance work are not started.
