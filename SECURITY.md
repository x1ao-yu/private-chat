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

Backend citations in these notes name files and symbols rather than line numbers: numeric
references rotted faster than the code they described, which is how a false claim survived
below in P2.

* `from` in `message` (`protocol/schema.json`) is an ephemeral **connection ID** — `generateClientID()` in `backend/internal/ws/transport.go` mints `peer-` + 4 random bytes per WebSocket, regenerated on reconnect. It is **not** a stable user ID or identity; P6 introduced identity keys. Do not treat `from` as authentication.
* **No history persistence** is a design goal: server is relay-only, in-memory `backend/internal/channel/manager.go` (`Manager.channels`), messages are not stored. Clients must not expect history on rejoin; P1 keeps this intentionally.
* Minimal `rate_limited` (`protocol/schema.json`, `backend/internal/ws/limiter.go`): `create_channel` 5/min per-IP + per-conn, `send_message` 10/s per-conn (fixed window, stdlib only). Exceeding returns `error rate_limited`. See P5 for the hardened set and for why per-IP limits need `TRUST_PROXY_XFF` behind a proxy.
* Heartbeat uses native WebSocket Ping/Pong (`Server.Handler` in `backend/internal/ws/transport.go`, 30s/5s timeout); no JSON heartbeat message.

## P2 Notes

* **E2EE**: `AES-GCM-256` via Web Crypto (`frontend/src/e2ee.ts` `createAesGcmCrypto`), `12B IV` per message `getRandomValues` never reused, `16B messageId` per message (`crypto.getRandomValues`), `AAD = v1|channelId|messageIdB64` binding room/version/message to prevent cross-context relocation. Envelope `payload = base64url(iv).base64url(messageId).base64url(ct+tag)` (tag 128-bit). Server relays `payload` verbatim (`Server.Handler` in `backend/internal/ws/transport.go`) and never logs plaintext.
* Room key is **per-room, ephemeral in memory, not permanent**: `generateRoomKey()` makes a 32B key with `getRandomValues`. Note the asymmetry — a freshly generated key is **extractable**, because `exportRoomKey` must serialize it once into the invite `#k=` fragment; a key **imported** from an invite is non-extractable (`importRoomKey` passes `extractable:false`) and can never be exported again. Do not treat the room key as a long-term secret; P5 added rotation, and P7 forward secrecy remains deferred.
* `isCryptoAvailable()` gate requires secure context (HTTPS or `localhost`); tests use `jsdom 27` forwarding to Node Web Crypto. Tamper of `iv`/`messageId`/`ct`/`AAD` causes `OperationError` decrypt failure, surfaced as `⚠️ decrypt failed`.
* Verification: `frontend/src/e2ee.test.ts` covers round-trip, tamper, cross-room AAD, IV/messageId uniqueness. "The server sees ciphertext only" is **structural, not test-proven by comparison**: `send_message.payload` is the only content field in the protocol, the relay treats it as opaque bytes, and `backend/internal/ws/transport_test.go` (`assertRelayed`) proves the server forwards `payload` byte-for-byte without parsing or rewriting it. There is deliberately no assertion that a relayed payload "differs from plaintext" — the server never handles plaintext at all, so no such comparison exists to make.

## P3 Notes

* Invite link format: `/r/{channelId}#k={base64url}`. The key is a 32-byte AES-256 key, exactly 43 chars unpadded base64url (`frontend/src/e2ee.ts` `isRoomKeyB64`), generated client-side with Web Crypto.
* Key validation on import (`importRoomKey`): strict base64url whitelist (charset + exact 43-char length) before any decode; malformed input fails with a specific error. A **wrong but well-formed key cannot be detected at import** (no protocol handshake exists; that belongs to P5/P6/P7) — it surfaces only as per-message `decrypt failed` placeholders.
* Hash hygiene (client-side secret handling): the room key travels **only** in the URL fragment, which browsers never send to the server; the relay protocol has no key field (`protocol/schema.json`, all messages `additionalProperties:false`). The landing hash is stripped via `history.replaceState` as soon as it is imported; SPA navigation (create/join/sidebar) never puts a key in the URL. A 43-char base64url string pasted into Join is rejected before any network request, so a key can never be sent to the server as a `channelId`.
* Key storage: tab memory only — a `CryptoKey` for crypto, plus an in-memory base64 copy used solely to rebuild invite links (`copyInviteLink`). A key imported from an invite is non-extractable; see P2 for why a freshly generated one is not. No localStorage/sessionStorage/cookies. **No persistence by design: a refresh drops the room key and rejoining requires re-pasting the invite key.**
* Key rotation and member removal are provided by P5 (cooperative, client-driven). Identity binding of keys arrived in P6, but keys are still not forward-secret — that remains P7 scope and is deferred.

## P4 Notes

* **No plaintext persistence / In-memory only / Single-instance**: server is relay-only, never stores messages (`backend/internal/channel/manager.go`, and `Server.Handler` in `backend/internal/ws/transport.go` never logs payload). State is `map[channelId]*channelInfo` + `connChannels` purely in memory, no DB/file. `backend/cmd/server/main.go` runs a 1m sweep `Manager.ExpireNow()`; restart drops all rooms. No horizontal scaling; the only startup parameter is `TRUST_PROXY_XFF` (see P5) — P4 explicitly keeps the single-instance memory model.
* **Room expiration (P4)**: `EmptyTTL = 10m` for rooms with 0 members, `IdleTTL = 24h` for any room without activity (`manager.go`). Activity = `Create`/`JoinIfRoom` or a valid `send_message` (`Touch`) which refreshes `lastActive`. The 1m sweep in `main.go` calls `Expire(now)`, which cleans both `channels` and the reverse index `connChannels`, and also reclaims expired rate-limit windows via `Server.CleanupRateLimits()`. Tests in `manager_test.go` cover 9m/11m empty, 23h/25h idle, join/touch refresh. `Leave`/`LeaveAll` keep emptied channels (the sweep is the sole deletion path), so a transient disconnect (e.g. client connection rebuild) rejoins within the TTL window instead of destroying the room.
* **Safe logging**: the server logs only `backend listening on :8080`, `expired N channels` (count only), `shutting down`, `shutdown: <err>`, and a fatal `listen: <err>` if the port cannot be bound. None of these carry a payload, plaintext, key, channelId list, peer-id or IP. `clientIP` feeds only the rate-limiter key and is never logged or persisted.
* **Metadata review (P4)**: server retains minimal metadata —
  - `channelId` (in `Manager.channels` keys; only ever counted in logs, never listed)
  - ephemeral `peer-id` (`peer-` + 4B per WebSocket via `generateClientID()`, in-memory only, regenerated on reconnect, never logged)
  - `online count` (derived, broadcast as `online_count`)
  - IP fixed-window counters (`limiter.go`; per-IP 5/min create plus 20/hour, per-conn 5/min create + 20/min join + 10/s send, per-IP 30/s send; reclaimed once each window passes its own duration)
  The IP these buckets key on is the TCP peer address by default, or the right-most `X-Forwarded-For` entry when `TRUST_PROXY_XFF=true` — see P5 for why that distinction decides whether per-IP limits mean anything at all.
  Does **not** retain: payload plaintext/ciphertext, keys, history, peer-id logs, IP logs beyond the limiter window. Client retains room key, session identity and `peer-id` only in tab memory; no localStorage/sessionStorage/cookies. Production must use HTTPS/WSS.

## P5 Notes

* **Replay protection (P5)**: `messageId` 16B random per envelope (`e2ee.ts` `newMessageIdB64`) is globally unique; clients maintain `ReplayCache` LRU 1000 per channel (`e2ee.ts`) and `ChannelStore` checks `extractMessageIdB64` before decrypt — a duplicate `messageIdB64` is dropped as `replay dropped` without decrypt. Server stays relay-only with no dedup (lightweight by design). **Residual risk, stated plainly:** the cache holds 1000 ids per channel per tab, so a ciphertext older than that window can be replayed and will decrypt as a fresh message; and `unwrapNewKey` rotation clears the cache. Envelope sanity `isValidEnvelope` (3 parts, base64url charset, iv 12B / mid 16B / ct≥16B) rejects malformed input before decrypt.
* **Message integrity (P5)**: `AES-GCM tag 128-bit` + `AAD v1|channelId|messageIdB64` (`e2ee.ts` `createAesGcmCrypto`) already provides outsider integrity; P5 adds the explicit `isValidEnvelope` pre-check and documents the boundary — it does **not** provide insider authentication (any holder of the room key can forge), that requires P6 identity. Tamper tests live in `e2ee.test.ts`; payload `<img onerror>` renders as plain text via `MessageList.svelte` `{m.payload}` (Svelte escapes, no `{@html}`).
* **Key rotation (P5)**: client generates new `AES-GCM-256` key `generateRoomKey` → `wrapNewKey(oldCrypto, newKeyB64)` (`e2ee.ts`) encrypts `JSON {k:43chars,v:1}` with the old key → `key_update {channelId,payload}` (`protocol/schema.json`) → server verifies membership and broadcasts `key_updated {channelId,payload,from,self}` (`Server.Handler` in `backend/internal/ws/transport.go`; verbatim relay, touches idle TTL, never logs payload). Receivers `unwrapNewKey`, `importRoomKey`, `createAesGcmCrypto`, `ReplayCache.clear()`, and `onKeyRotated` syncs the `App.svelte` maps. New invite auto-copied.
* **Member removal (P5)**: cooperative only, no server kick (see Principles). Removal = local rotation `rotateKeyLocally` in `App.svelte` (generate new key, `updateCrypto`, copy new invite, system hint) **without** `key_update` broadcast; only members who receive the new invite out-of-band stay. Old members' ciphertext decrypts as `⚠️ decrypt failed` and is isolated. There is no `peer-id` kick API.
* **Rate limiting (P5, corrected)**: `create 5/min per-IP + 5/min per-conn + 20/hour per-IP`, `join/leave 20/min per-conn`, `send/key_update/set_room_name/set_nickname 10/s per-conn + 30/s per-IP`, `maxMembers 100`. All fixed-window counters in `backend/internal/ws/limiter.go` (stdlib only). Three things this originally claimed but did **not** deliver, and now does:
  * Each window is reclaimed against **its own duration**. The collector previously assumed every window was one minute old, which reset the per-IP hourly create budget roughly every minute and degraded `20/hour` to about `20/minute`. Collection runs both per-connection on disconnect and periodically from the 1-minute sweep in `main.go`.
  * Per-IP limits key on the **real client address**. `Server.clientIP` uses the TCP peer address by default; `TRUST_PROXY_XFF=true` switches it to the right-most `X-Forwarded-For` entry, the one a trusted proxy appends and a client cannot overwrite — taking the left-most instead would let a client choose its own bucket. Off by default so a directly reachable backend never believes a client header. Behind the shipped nginx proxy this is mandatory, otherwise every client shares the proxy address and "per-IP" silently means "global". Unparseable values fall back to the peer address.
  * The member cap is enforced **in the same locked step as the join**. `Manager.JoinIfRoom` checks existence and capacity and mutates under one write lock, closing the window where concurrent joins each passed a separate `Count` check and collectively overshot 100.
  The counter is a fixed window, **not** a token bucket: there is no burst parameter. "~20" is only the emergent worst case when 10/s requests straddle a window boundary; do not describe it as a burst allowance.
* **WebSocket origin verification**: the handler uses the library's default same-origin check (`websocket.Accept(w, r, nil)`); a handshake whose `Origin` host differs from the request `Host` is refused with 403. This closes the cross-site WebSocket hijacking window that the previous unconditional `InsecureSkipVerify: true` left open in every deployment. There is deliberately no origin configuration surface — clients connect to their own origin. Consequence for operators: `frontend/nginx.conf` must forward the original Host **including the port** (`$http_host`), because nginx's `$host` drops the port while the browser's `Origin` keeps it, and a cross-origin deployment requires adding `OriginPatterns` in the Go source.
* **XSS/security review (P5)**: `MessageList.svelte` uses text interpolation only (`grep {@html|innerHTML}` returns 0), `frontend/index.html` sets CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'`, and `frontend/nginx.conf` adds `frame-ancestors 'none'`, `X-Frame-Options DENY`, `X-Content-Type-Options nosniff` and `Referrer-Policy no-referrer`. Production requires HTTPS/WSS.
* **Display names (post-P5 patch, UI only)**: `room_name` (1-32) / `nick` (1-20) are display-only, per-room, tab-memory (`App.svelte` `roomNames`/`selfNicks`/`peerNicks`), E2EE-synced via `set_room_name`/`set_nickname` → `room_name_updated`/`nickname_updated` (`protocol/schema.json`; `e2ee.ts` wraps `JSON {t,v,name/nick}`) and the server only relays. **Not identity/auth** on their own — any holder of the room key can spoof an unsigned claim; P6 signatures attribute signed content. XSS safe via text interpolation, length/no-newline validation (`isValidRoomName`/`isValidNick`). Note `|` is a permitted nickname character; the identity-v2 signature encoding is what makes that safe rather than ambiguous. `Sidebar` truncates with a `title` fallback, room list max-width fixed.

## P6 Notes

* **Identity key (P6)**: `Ed25519` via Web Crypto (`frontend/src/identity.ts`), one **fresh keypair per room session** — generated by each `ChannelStore`, so identities are **cross-room unlinkable**. Tab memory only — never persisted (still zero localStorage/sessionStorage/cookies); it survives WS reconnects (the store keeps it) and disappears on Leave/refresh by design. **Private key is non-extractable**: Web Crypto applies one extractable flag to the whole pair, so the pair is generated extractable and the private key is immediately re-imported from a one-time pkcs8 export with `extractable: false`; the original is dropped and the pkcs8 bytes transit JS memory exactly once (never stored, never sent). The UI presents it as **"this session's identity"**, never as a permanent identity. The public key (32B raw, 43-char base64url — same shape as room keys) travels only inside the E2EE payload; the server never sees it (still ciphertext-only, `protocol/schema.json` unchanged — zero backend changes). Fingerprint `fp = pubB64.slice(0,10)` is display-only; the full pk always travels in each signed payload.
* **Signature encoding is identity-v2**: variable-length fields are prefixed with their **UTF-8 byte length** (`frame()` in `identity.ts`) and each context carries a domain-separation tag, so the signed string is injective:
  * messages sign `identity-v2|msg|channelId|messageIdB64|<len>:nick|<len>:text`
  * nick claims sign `identity-v2|nick|channelId|<len>:nick`
  * `channelId` and `messageIdB64` are charset-restricted (`[A-Za-z0-9_-]`) and need no frame; `nick` and `text` are user-controlled and do.
* **Why v2 exists — identity-v1 was malleable**: v1 joined fields with a literal `|` while `isValidNick` permitted `|`, so `("Alice", "meet at 9|room 3")` and `("Alice|meet at 9", "room 3")` produced the *same* signed string. Any holder of the room key could take another member's valid signature and re-present it as a different nickname/text pair, and it verified — and the TOFU layer pinned the forged nickname as cleanly verified rather than flagging it. **Attribution of signed content therefore only holds from v2 onward.** Do not describe v1-era signatures as unforgeable.
* **Signed payloads**: chat inner plaintext is JSON `{t:"msg",v:2,text,nick,pk,sig}` (`wrapSignedMessage`); the messageId is pre-generated via `newMessageIdB64()` and passed to `encrypt(plain, {messageIdB64})`, so envelope, AAD and signature all cover the same id. Nickname updates are `{t:"nick",v:1,nick,pk,sig}` (`wrapSignedNick`) — the inner `v` stays 1 deliberately, because `unwrapNick` is the shared receive parser for signed *and* unsigned nick claims and the trust decision is carried by the signature encoding, not that field. Room-name updates stay unsigned (low value). Unsigned legacy compatibility is additive: raw-text messages and unsigned nick updates from clients without identity are still accepted and rendered — **visibly marked** with a gray "no identity" chip, not silently trusted.
* **Identity verification (P6, TOFU)**: per room, tab memory (`ChannelStore.recordIdentity` / `nickToFp`): the first verified claim of a nick pins nick→fingerprint; every signed message is verified on receive. Invalid signature → content is **hidden** (`⚠️ invalid signature`, same policy as decrypt-failed). **Key-change warning (accepted TOFU limitation)**: the same nick claimed by a different fingerprint is flagged `conflict` on the bubble (amber chip) **and** announced once per contested (nick, fingerprint) pair as a system timeline message ("fresh session identity or impersonation" — with per-room session keys a refresh legitimately produces this). Additionally, one WS connection presenting two different identity keys raises `identity mismatch on connection` (our client never rotates mid-connection — an impersonation signal). That connection check is a *warning banner only*; it does not drop the message, and a fresh connection clears it, so it is not a defence. Avatar colors key on the identity fingerprint (stable across reconnects) instead of the ephemeral conn id (`MessageList.svelte`).
* **Stale v1 claims are never trusted, and never silently dropped**: `staleSignedMessagePk` recognizes a well-formed `{t:"msg",v:1}` claim, which renders as `⚠️ stale signature — refresh to upgrade` under the existing `invalid` status. The unvalidated v1 nickname is deliberately not carried into the identity layer and no TOFU pin is recorded from it. Unsigned raw-text legacy messages are unaffected and still render with the "no identity" chip. Signed nick claims made by pre-v2 clients fail `verifySignedNick` and are dropped with a visible error.
* **Forward compatibility (P6)**: an inner plaintext that parses as JSON with a `t` type tag but is not a valid current signed message (`isUnknownStructuredPayload`) is **ignored entirely** — never rendered as raw JSON (mixed-version rooms: newer clients' payloads don't leak format gibberish into older timelines; user text that merely looks like JSON but has no type tag still renders). Stale v1 is handled by the explicit path above rather than by this one, precisely because ignoring it silently would hide a real degradation.
* **No silent degradation (P6)**: if Ed25519 is unavailable the unsigned path still works, but it is **explicitly marked**: amber "identity auth unavailable" badge in the room header (plus a notice on the home page), and every unsigned message carries the gray "no identity" chip with an explanatory tooltip. The same principle drives the stale-v1 notice above.
* **Boundaries (P6)**: TOFU only — no PKI, no out-of-band verification protocol; a fresh key claiming a fresh nick is indistinguishable from a new member. **Unsigned** legacy claims remain spoofable by room-key holders (accepted trade-off of the additive layer); **v2-signed** content is not, though it was under v1. This is **pseudonymity, not anonymity**: keys are per-room, but the same room session presents the same keypair to all its members, and a refresh/leave+rejoin produces a new identity. Identity-key rotation is not provided (P7 scope).
* **Payload budget (P6)**: the wire limit stays 8192 and identity-v2 did not change it — the length prefixes and `msg` tag live only in the string being signed, never on the wire, and the inner JSON grew by zero bytes (`v:1`→`v:2`). The inner plaintext budget is derived and enforced **before** encrypting (`MAX_INNER_UTF8 = 6098` UTF-8 bytes in `codec.ts`: 8192 − 40 envelope overhead, b64url ¾ expansion, − 16 tag), so oversized input fails with a clear `message too long` error instead of a generic encode failure after the ~250-char signed-JSON overhead.

## P7 Notes

* **Evaluation done, adoption deferred** (2026-09-05): see `docs/mls-evaluation.md`. MLS
  (RFC 9420) is the only standardized protocol that provides group FS/PCS; the only audited
  implementation (OpenMLS, SRLabs 2026-05) has no official JS bindings, and the only
  browser-native path (ts-mls) is unaudited. Adoption is deferred until one of the documented
  unlock conditions holds.
* **No FS/PCS claims**: the current model does NOT provide forward secrecy or post-compromise
  security. There is one shared room key per session (P3); compromise of that key exposes all
  messages within its exposure window. Manual rotation (P5 "Rotate & share" / "Rotate
  locally") is the only exposure-window control, and it is cooperative/discretionary — not a
  protocol guarantee. P6 signatures provide insider attribution of message content (from
  identity-v2 only; v1 signatures were malleable — see P6 Notes); they do not change key
  distribution, and the v1→v2 change is an encoding fix, not a key-management one.
* **Honest scope statement**: even a future session-scoped MLS adoption (no persistence by
  design) would deliver FS within a session and PCS within the epoch chain — not across
  restarts. Any adoption requires the infra gaps documented in `docs/mls-evaluation.md` §5
  (per-room commit ordering, payload framing, in-band KeyPackage signaling) to be addressed
  in an approved plan first.

## Security-Sensitive Changes

Review carefully before implementing:

* cryptographic protocols
* key management
* identity
* key rotation
* file encryption
* WebRTC security
