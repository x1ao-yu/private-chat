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

## Security-Sensitive Changes

Review carefully before implementing:

* cryptographic protocols
* key management
* identity
* key rotation
* file encryption
* WebRTC security
