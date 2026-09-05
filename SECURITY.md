# SECURITY.md

## Principles

* Plaintext messages must never be sent to the server
* Private keys and room secrets must remain client-side whenever possible
* Never log plaintext, private keys, or encryption keys
* Use standard cryptographic APIs or audited libraries
* Never invent custom cryptography
* Use secure randomness for security-sensitive values
* Validate and authenticate encrypted messages
* Consider replay attacks and message injection
* Membership changes must consider key rotation
* Treat XSS and malicious client code as major security risks
* Minimize server-side storage and metadata
* Production communication should use HTTPS/WSS

## Important

E2EE does not automatically provide:

* anonymity
* zero metadata
* authentication
* forward secrecy

Do not claim a security property unless the protocol and implementation actually provide it.

## P1 Notes

* `from` in `message` (`protocol/schema.json:106`) is an ephemeral **connection ID** (`peer-` + 4B random per WebSocket, `backend/internal/ws/transport.go:210`), regenerated on reconnect. It is **not** a stable user ID or identity; P6 will introduce identity keys. Do not treat `from` as authentication.
* **No history persistence** is a design goal: server is relay-only, in-memory `backend/internal/channel/manager.go:11`, messages are not stored. Clients must not expect history on rejoin; P1 keeps this intentionally.
* Minimal `rate_limited` (`protocol/schema.json:129`, `backend/internal/ws/limiter.go:1`): `create_channel` 5/min per-IP + per-conn, `send_message` 10/s per-conn burst 20 (fixed window, stdlib only). Exceeding returns `error rate_limited`.
* Heartbeat uses native WebSocket Ping/Pong (`backend/internal/ws/transport.go:49`, 30s/5s timeout); no JSON heartbeat message.

## P2 Notes

* **E2EE**: `AES-GCM-256` via Web Crypto (`frontend/src/e2ee.ts:1`), `12B IV` per message `getRandomValues` never reused, `16B messageId` per message (`crypto.getRandomValues`), `AAD = v1|channelId|messageIdB64` binding room/version/message to prevent cross-context relocation. Envelope `payload = base64url(iv).base64url(messageId).base64url(ct+tag)` (tag 128-bit). Server relays `payload` verbatim (`backend/internal/ws/transport.go:167`) and never logs plaintext.
* Room key is **per-room, ephemeral in memory, not permanent**: `generateRoomKey()` 32B `getRandomValues`, `extractable:false` in-memory, exported only via `exportRoomKey` base64url for invite hash `#k=` (client-side, never sent to server). Do not treat room key as long-term secret; P5 will add rotation, P7 FS.
* `isCryptoAvailable()` gate requires secure context (HTTPS or `localhost`); tests use `jsdom 27` forwarding to Node Web Crypto. Tamper of `iv`/`messageId`/`ct`/`AAD` causes `OperationError` decrypt failure, surfaced as `⚠️ decrypt failed`.
* Verification: `frontend/src/e2ee.test.ts:1` covers round-trip, tamper, cross-room AAD, IV/messageId uniqueness; `transport_test.go` asserts `payload` != plaintext.

## P3 Notes

* Invite link format: `/r/{channelId}#k={base64url}`. The key is a 32-byte AES-256 key, exactly 43 chars unpadded base64url (`frontend/src/e2ee.ts` `isRoomKeyB64`), generated client-side with Web Crypto.
* Key validation on import (`importRoomKey`): strict base64url whitelist (charset + exact 43-char length) before any decode; malformed input fails with a specific error. A **wrong but well-formed key cannot be detected at import** (no protocol handshake exists; that belongs to P5/P6/P7) — it surfaces only as per-message `decrypt failed` placeholders.
* Hash hygiene (client-side secret handling): the room key travels **only** in the URL fragment, which browsers never send to the server; the relay protocol has no key field (`protocol/schema.json`, all messages `additionalProperties:false`). The landing hash is stripped via `history.replaceState` as soon as it is imported; SPA navigation (create/join/sidebar) never puts a key in the URL. A 43-char base64url string pasted into Join is rejected before any network request, so a key can never be sent to the server as a `channelId`.
* Key storage: tab memory only — a non-extractable `CryptoKey` (`extractable:false`) for crypto, plus an in-memory base64 copy used solely to rebuild invite links (`copyInviteLink`). No localStorage/sessionStorage/cookies. **No persistence by design: a refresh drops the room key and rejoining requires re-pasting the invite key.**
* Key rotation, member removal, and identity binding of keys are not provided at this stage (P5/P6).

## P4 Notes

* **No plaintext persistence / In-memory only / Single-instance**: server is relay-only, never stores messages (`backend/internal/channel/manager.go:24-33`, `backend/internal/ws/transport.go:30` never logs payload). State is `map[channelId]*channelInfo` + `connChannels` purely in memory, no DB/file. `backend/cmd/server/main.go:21-30` runs a 1m sweep `Manager.ExpireNow()`; restart drops all rooms. No horizontal scaling or startup params by design — P4 explicitly keeps single-instance memory model.
* **Room expiration (P4)**: `EmptyTTL = 10m` for rooms with 0 members, `IdleTTL = 24h` for any room without activity (`backend/internal/channel/manager.go:12-16`). Activity = `Create`/`Join` (`manager.go:60-93`) or valid `send_message` (`ws/transport.go:158-160` `Touch`) which refreshes `lastActive`. Sweep runs every minute (`main.go:21-30`), calls `Expire(now)` which cleans both `channels` and reverse index `connChannels` (`manager.go:169-205`). Tests in `backend/internal/channel/manager_test.go:1` cover 9m/11m empty, 23h/25h idle, join/touch refresh. `Leave`/`LeaveAll` keep emptied channels (the sweep is the sole deletion path), so a transient disconnect (e.g. client connection rebuild) rejoins within the TTL window instead of destroying the room.
* **Safe logging**: server logs only `listening` (`main.go:33`) and `expired N channels` (`main.go:27`) — count only, no `payload`, no `channelId` list by default (allowed but not used), never peer-id/IP/payload. `ws/transport.go:30` documents never logs payload; `clientIP` is used only for rate-limiter key (`ws/transport.go:95`) and never logged or persisted beyond `limiter.go:12` fixed-window 60s GC.
* **Metadata review (P4)**: server retains minimal metadata —
  - `channelId` (in `manager.channels` keys, allowed to log for expiration count)
  - ephemeral `peer-id` (`peer-`+4B per WebSocket `ws/transport.go:239-241`, in-memory only, regenerated on reconnect, never logged)
  - `online count` (derived, broadcast as `online_count`)
  - IP fixed-window counters (`limiter.go:12-16`, per-IP 5/min create, per-conn 5/min + 10/s send, lazy GC after 60s)
  Does **not** retain: payload plaintext/ciphertext, keys, history, peer-id logs, IP logs beyond limiter window. Client retains room key + `peer-id` only in tab memory; no localStorage/sessionStorage/cookies. Production must use HTTPS/WSS and disable `InsecureSkipVerify`.

## P5 Notes

* **Replay protection (P5)**: `messageId` 16B random per envelope `frontend/src/e2ee.ts:94-97` is globally unique; clients maintain `ReplayCache` LRU 1000 per channel `frontend/src/e2ee.ts:51-75` and `frontend/src/channel.svelte.ts:106-148` checks `extractMessageIdB64` before decrypt — duplicate `messageIdB64` is dropped as `replay dropped` without decrypt. Server still relay-only, no dedup (lightweight). Envelope sanity `isValidEnvelope` (`e2ee.ts:34-49`: 3 parts, base64url charset, iv 12B/mid 16B/ct≥16B) rejects malformed before decrypt.
* **Message integrity (P5)**: `AES-GCM tag 128-bit` + `AAD v1|channelId|messageIdB64` `e2ee.ts:98-124` already provides outsider integrity; P5 adds explicit `isValidEnvelope` pre-check and documents boundary — does **not** provide insider authentication (any holder of room key can forge), that requires P6 identity. Tamper tests remain `e2ee.test.ts:77-104`; payload `<img onerror>` renders as plain text via `MessageList.svelte:34,56` `{m.payload}` (Svelte escapes, no `{@html}`).
* **Key rotation (P5)**: client generates new `AES-GCM-256` key `generateRoomKey` → `wrapNewKey(oldCrypto, newKeyB64)` `e2ee.ts:170-186` encrypts `JSON {k:43chars,v:1}` with old key → `key_update {channelId,payload}` `protocol/schema.json:66-77` → server verifies membership and broadcasts `key_updated {channelId,payload,from,self}` `backend/internal/ws/transport.go:210-240` (verbatim relay, touches idle TTL, never logs payload). Receivers `unwrapNewKey` `e2ee.ts:188-200`, `importRoomKey`, `createAesGcmCrypto`, `ReplayCache.clear()`, `onKeyRotated` syncs `App.svelte:178-185` maps. New invite auto-copied.
* **Member removal (P5)**: cooperative only, no server kick `SECURITY.md:13`. Removal = local rotation `App.svelte:280-310` `rotateKeyLocally` (generate new key, `updateCrypto`, copy new invite, system hint) **without** `key_update` broadcast; only members who receive new invite (out-of-band) stay. Old members’ ciphertext decrypts as `⚠️ decrypt failed` and is isolated. No `peer-id` kick API.
* **Rate limiting (P5)**: hardened to `create 5/min per-IP+per-conn + 20/hour per-IP (maxChannels/IP)` `transport.go:96-103`, `join/leave 20/min per-conn` `transport.go:118-133`, `send/key_update 10/s per-conn burst20 + 30/s per-IP` `transport.go:141-240`, `maxMembers 100` `transport.go:125`. All fixed-window `backend/internal/ws/limiter.go:30-49` stdlib, `CleanupExpired` 60s + per-conn cleanup on disconnect `transport.go:44-47`.
* **XSS/security review (P5)**: `MessageList.svelte:34,56` text interpolation safe, `grep {@html|innerHTML}` 0, `frontend/index.html:8-11` CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'` + `frontend/nginx.conf:6` adds `frame-ancestors 'none'` + `X-Content-Type-Options nosniff` etc. Production requires HTTPS/WSS, `InsecureSkipVerify` stays dev-only `transport.go:33`.
* **Display names (post-P5 patch, UI only)**: `room_name` (1-32) / `nick` (1-20) are display-only, per-room, tab-memory (`App.svelte: roomNames/selfNicks/peerNicks`), E2EE-synced via `set_room_name`/`set_nickname` → `room_name_updated`/`nickname_updated` (`protocol/schema.json:79-109`, `e2ee.ts:207-250` wrap `JSON {t,v,name/nick}`) and server only relays. **Not identity/auth** — any holder of room key can spoof, P6 will introduce verifiable identity. XSS safe via text interpolation (`MessageList.svelte`), length/no-newline validation (`isValidRoomName`/`isValidNick`). `Sidebar` truncates with `title` fallback, room list max-width fixed.

## P6 Notes

* **Identity key (P6)**: `Ed25519` via Web Crypto (`frontend/src/identity.ts:1`), one keypair per browser tab, shared across rooms. Tab memory only — never persisted (still zero localStorage/sessionStorage/cookies), regenerated on every refresh by design; it survives WS reconnects because the per-room store keeps it. The UI presents it as **"this session's identity"**, never as a permanent identity. The public key (32B raw, 43-char base64url — same shape as room keys) travels only inside the E2EE payload; the server never sees it (still ciphertext-only, `protocol/schema.json` unchanged — zero backend changes). Fingerprint `fp = pubB64.slice(0,10)` is display-only; the full pk always travels in each signed payload.
* **Signed payloads (P6)**: the chat inner plaintext upgrades from raw text to JSON `{t:"msg",v:1,text,nick,pk,sig}` (`wrapSignedMessage`), nickname updates to `{t:"nick",v:1,nick,pk,sig}` (`wrapSignedNick`). Signature data binds identity to context: messages sign `identity-v1|channelId|messageIdB64|nick|text` (the messageId is pre-generated via `newMessageIdB64()` and passed to `encrypt(plain, {messageIdB64})`, so envelope, AAD and signature cover the same id); nick claims sign `identity-v1|nick|channelId|nick`. Room-name updates stay unsigned (low value). Legacy compatibility is additive: unsigned raw-text messages and unsigned nick updates from old clients are still accepted and rendered without identity.
* **Identity verification (P6, TOFU)**: per room, tab memory (`ChannelStore.recordIdentity` / `nickToFp`): the first verified claim of a nick pins nick→fingerprint; every signed message is verified on receive. Invalid signature → content is **hidden** (`⚠️ invalid signature`, same policy as decrypt-failed); the same nick claimed by a different fingerprint is flagged `conflict` (amber chip). Avatar colors key on the identity fingerprint (stable across reconnects) instead of the ephemeral conn id (`MessageList.svelte`).
* **Boundaries (P6)**: TOFU only — no PKI, no out-of-band verification protocol; a fresh key claiming a fresh nick is indistinguishable from a new member. Unsigned legacy claims remain spoofable by room-key holders (accepted trade-off of the additive layer; signed content is not). This is **pseudonymity, not anonymity**: one tab presents the same keypair in every room it joins, so cross-room activity is linkable by members. Identity-key rotation is not provided (P7 scope).
* **Payload budget (P6)**: the signed message JSON adds ~250 chars inside the envelope; `payload` stays ≤ 8192 at protocol level, so the plaintext budget shrinks accordingly (near-limit messages fail protocol validation client-side with a visible error).

## Security-Sensitive Changes

Review carefully before implementing:

* cryptographic protocols
* key management
* identity
* key rotation
* file encryption
* WebRTC security
