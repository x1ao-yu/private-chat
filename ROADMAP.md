# ROADMAP.md

## P0 — Foundation

* [x] Project structure
* [x] Frontend
* [x] Backend
* [x] Shared protocol
* [x] WebSocket
* [x] Docker
* [x] Tests

## P1 — Minimal Chat

* [x] Create room
* [x] Join/leave room
* [x] Message relay
* [x] Reconnect
* [x] Online count

## P2 — E2EE

* [x] Client-side key generation
* [x] Message encryption/decryption
* [x] Encrypted message protocol
* [x] Verify server sees ciphertext only

## P3 — Room Keys

* [x] Room secret
* [x] Invite/link format
* [x] Client-side secret handling
* [x] Key validation

## P4 — Privacy

* [x] No plaintext persistence
* [x] In-memory room state
* [x] Room expiration
* [x] Safe logging
* [x] Metadata review

## P5 — Security

* [x] Replay protection
* [x] Message integrity
* [x] Key rotation
* [x] Member removal
* [x] Rate limiting
* [x] XSS/security review

## P6 — Anonymous Identity

* [x] Identity key
* [x] Anonymous display identity
* [x] Identity verification

## P7 — Advanced E2EE

* [ ] Group key management (deferred — see docs/mls-evaluation.md)
* [ ] Forward secrecy (deferred — see docs/mls-evaluation.md)
* [ ] Post-compromise security (deferred — see docs/mls-evaluation.md)
* [x] Evaluate standardized group protocols (docs/mls-evaluation.md — adoption deferred, unlock conditions documented)

## P8 — Advanced Communication

* [ ] Encrypted files
* [ ] Images
* [ ] WebRTC
* [ ] Voice/video

## P9 — Productization

* [x] Mobile UX
* [ ] PWA
* [ ] Performance
* [x] Deployment
* [ ] Abuse protection (rate limits + WS origin verification landed and tested; no moderation or reporting tooling)
* [ ] Security audit preparation

## Current

**P7 is closed as "evaluate and defer"** — see `docs/mls-evaluation.md`; group key management,
forward secrecy and post-compromise security stay deferred until one of its unlock conditions holds.

**P9 is in progress** — Mobile UX and Deployment shipped; the abuse-protection controls that
P5 claimed (per-IP limits and the member cap) were only made effective together with WebSocket
origin verification, so that item is annotated rather than checked. PWA, Performance and
security-audit preparation are not started. P8 is untouched.
