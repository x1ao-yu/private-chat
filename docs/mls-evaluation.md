# P7 Evaluation — Standardized Group Protocols (MLS)

Status: **evaluation complete, adoption deferred** (decision below). This document is the
record for ROADMAP P7 item "Evaluate standardized group protocols". Evaluation date:
2026-09-05. No dependency was introduced; nothing in this document changes running code.

## 1. Scope and hard constraints

Private Chat is a lightweight, browser-based E2EE chat:

* Server is a **relay-only broadcast fan-out**: in-memory channel → conn sets, no storage,
  no accounts, no per-user identity (backend/internal/channel/manager.go). Restart drops
  all state; emptied rooms expire (EmptyTTL 10m / IdleTTL 24h).
* Clients are browser-only (Vite + TS, Web Crypto). No Node-only or native targets.
* Project rules (AGENTS.md / SECURITY.md): **never invent cryptographic protocols**; use
  standard crypto APIs **or audited libraries**; avoid unnecessary dependencies and
  infrastructure; do not claim a security property the implementation does not provide.

P7 asks for group key management, forward secrecy (FS) and post-compromise security (PCS).
Any scheme delivering those is a group key agreement — exactly the territory where a
hand-rolled "simplified MLS" is forbidden. The only permitted path is adopting a
standardized protocol (MLS, RFC 9420) through an audited implementation.

## 2. Current state and the honest gap

Today a room holds **one shared AES-256-GCM key** per session (P3), rotated manually via an
E2EE-wrapped `key_update` (P5). P6 adds sender attribution (per-room Ed25519 signatures) but
does not change key distribution.

What this means, stated plainly:

* **No forward secrecy**: compromise of the current room key decrypts every message sent
  under it within the exposure window. Manual rotation ("Rotate & share" / "Rotate locally")
  is the only exposure-window control, and it is cooperative and discretionary.
* **No post-compromise security**: a leaked key never recovers; only a manual rotation by a
  remaining member re-secures the room, and there is no protocol guarantee all members
  converge on the new key.
* **Insider authentication** of message *content authorship* is provided by P6 signatures;
  key *distribution* remains single-point.

## 3. Standardized protocol candidates

* **MLS (RFC 9420)** — IETF standardized group key agreement with tree-KEM: FS, PCS,
  per-member keys, asynchronous membership changes. This is the only standard that delivers
  the P7 properties for group chat. Complemented by RFC 9750 (MLS Architecture, April 2025),
  which defines what a Delivery Service must do.
* **Signal Sender Keys** — group construction on top of pairwise Double Ratchet. No
  browser-usable audited implementation exists (see §4); the protocol itself is not an IETF
  standard.
* **p2panda-encryption** — explicitly *custom* group schemes, self-described as unstable and
  un-audited. **Excluded** by the no-custom-protocols constraint.
* **Discord DAVE** — production MLS-in-browser precedent (MLSPP core + TS/WASM), but
  purpose-built for Discord's call pipeline, not a reusable chat library.

## 4. Implementation options (verified 2026-09-05)

| Option | Protocol | Third-party audit | Browser/JS today | Infra / toolchain cost | Maintenance risk |
|---|---|---|---|---|---|
| **OpenMLS** + self-built WASM bindings | MLS 9420, interop-tested | **Yes — SRLabs, published 2026-05-27** (8 findings, 1 High; fixed in 0.8.1/0.7.3, Feb 2026; 1 Low open at publication) | Compiles with the official `js` feature, but **no official JS bindings** (openmls#487 open) — we would own a wasm-bindgen/TS shim **outside the audit** | Rust/wasm-pack toolchain in CI, WASM bundle weight; conflicts with "lightweight" | Low-moderate (Phoenix R&D/Cryspen, openmls 0.9.0 Aug 2026) |
| **ts-mls** (pure TypeScript) | MLS 9420 (all base + PQ suites via @hpke/core) | **No** — README: "has not undergone a formal security audit" | **Excellent** — pure TS, Web Crypto, works in Vite today; ~12.7k downloads/week; `createGroupInfoWithExternalPubAndRatchetTree` supports in-band tree conveyance | Minimal (one runtime dep) | Moderate-high (solo maintainer, first release 2025, 2.0 RC churn) |
| **AWS mls-rs** + WASM | MLS 9420 (conformance-validated) | **No** ("has not yet received a full security audit") | WASM builds supported + `mls-rs-crypto-webcrypto` (v0.15.0), but DIY bindings | Rust/WASM toolchain, DIY shim | Low (AWS-backed) |
| **@signalapp/libsignal-client** | Signal (Sender Keys exposed in TS) | Protocol audit (2016, academic); no audit of current codebase | **Node-only** native bindings; no browser/WASM target; "Use outside of Signal is unsupported"; AGPL-3.0-only | — | **Not viable** for this project |
| **p2panda-encryption** | Custom (not MLS) | Announced pending, no published report | — | — | **Excluded** (custom protocol) |

OpenMLS is the only audited codebase; ts-mls is the only pragmatic browser-native path.

## 5. Architecture fit: broadcast relay vs Delivery Service

RFC 9750 §5 defines the Delivery Service roles. The encouraging part — our architecture is
closer than assumed:

* **Broadcast-only delivery is RFC-sanctioned.** RFC 9420 §3.2: Welcome messages "could be
  distributed more broadly, say if the application only had access to a broadcast channel
  for the group" (they are encrypted to the joiner). RFC 9750 §5.2.1 describes exactly our
  shape as a viable DS: an "ordering server" that "broadcasts all messages received to all
  users and ensures that all clients see messages in the same order", letting clients apply
  the first valid Commit per epoch.
* **No KeyPackage directory needed if joins are synchronous**: members online simultaneously
  can exchange KeyPackages in-band (as opaque relayed payloads), and the ratchet tree can be
  conveyed in GroupInfo/Welcome (RFC 9420; ts-mls supports it), avoiding server-side tree
  storage.

Real gaps between today's relay and an MLS-grade ordering server (facts, with references):

1. **No cross-sender commit ordering.** Broadcasts run in each sender's handler goroutine;
   map iteration is randomized; there is no sequencing. Two concurrent Commits can reach
   different members in different orders → group divergence. MLS needs a single order per
   room (server-side per-room sequencing, or a client epoch-guard that is only sound under a
   common order). Backend facts: per-recipient broadcast loops in the `SendMessage` / `KeyUpdate`
   / `SetRoomName` / `SetNickname` cases of `transport.go` (`Server.Handler`), no sequence
   numbers, failed writes silently dropped.
2. **Payload ceiling 8192 chars** (schema.json, all 8 payload defs + gen.go checks +
   the `payload too large` check in `codec.ts`). MLS KeyPackages/Commits/Welcome routinely
   exceed 8 KB for moderate group sizes; would need a limit raise (WS read limit is 1 MiB,
   `c.SetReadLimit(1 << 20)` in `transport.go`) and/or chunked framing. Rate limits would need
   revisiting too.
3. **KeyPackage single-use cannot be enforced server-side** (no storage, no identity). With
   in-band exchange it degrades to client-side best-effort; RFC 9750 §5.1 expects the DS to
   enforce single-use.
4. **No persistence → per-session group setup.** Group state dies with the tab; members
   re-run group setup every session. Acceptable for ephemeral rooms (MLS re-establishment is
   cheap), but it means FS benefits are bounded to a session anyway — worth stating upfront:
   **without any persistence, session-scoped MLS gives FS within the session and PCS within
   the epoch chain, not across restarts.**
5. **Membership-change visibility**: today peers only see an anonymous `online_count` — no
   roster, so membership-change driven epoch updates would need new in-band signaling.

## 6. Governance analysis

* **Adopting ts-mls today = a documented exception** to "standard crypto APIs or audited
  libraries". Mitigations (mandatory if ever adopted): pin the exact version, vendor-audit
  the diff on upgrades, keep MLS usage behind a narrow internal interface so the
  implementation can be swapped, gate on the `epoch_authenticator` comparison RFC 9750 §5.2
  recommends for detecting relay partitioning. None of these substitute for an audit.
* **OpenMLS path**: audit covers the Rust core only; our wasm-bindgen/TS shim is unaudited
  glue (smaller surface than a protocol, but real), plus a permanent Rust/WASM toolchain and
  bundle-weight cost that sits badly with the project's lightweight mandate.
* **Doing nothing is also a governance position**: the roadmap would keep claiming no FS/PCS,
  which is honest, and the P5 manual rotation stays the documented exposure-window control.

## 7. Decision (2026-09-05)

**Defer adoption.** No MLS dependency is introduced at this stage. Reasons: the only audited
implementation requires a self-built binding layer and a toolchain that conflicts with the
project's constraints; the only browser-native path (ts-mls) is unaudited and would require
amending a core security principle; and the integration itself (ordering, payload framing,
group lifecycle redesign) is a multi-milestone effort that deserves its own approved plan.

ROADMAP outcome: "Evaluate standardized group protocols" is **done** (this document); Group
key management / FS / PCS remain **open, deferred** — no code claims them.

## 8. Unlock conditions (re-evaluate when any becomes true)

1. **ts-mls publishes a formal third-party audit** → it becomes the default candidate; plan
   integration (server per-room commit sequencing, payload framing, in-band KeyPackage
   signaling, session-scoped group lifecycle).
2. **Project owner explicitly amends the audited-library principle** to allow unaudited
   implementations of standardized protocols with pinned versions → ts-mls integration can
   be planned under the mitigations in §6.
3. **OpenMLS ships official JS/WASM bindings** (openmls#487) → the audited-core path loses
   its main cost; re-compare against ts-mls.

Until then: no FS/PCS claims anywhere in the docs; P5 manual rotation remains the only
key-exposure control; P6 signatures remain the only insider attribution.

## 9. Sources

* RFC 9420 (MLS): <https://www.rfc-editor.org/rfc/rfc9420.txt> — §3.2 (broadcast Welcome,
  proposal availability, commit ordering note), §3.3 (external joins), §16.6 (KeyPackage
  refresh)
* RFC 9750 (MLS Architecture, April 2025): <https://www.rfc-editor.org/rfc/rfc9750.txt> —
  §5, §5.1 (directory, single-use), §5.2 (delivery patterns, ordering server), §5.2.1
* OpenMLS SRLabs audit (published 2026-05-27):
  <https://blog.phnx.im/openmls-independent-security-audit/>
* OpenMLS WASM (`js` feature): <https://book.openmls.tech/user_manual/wasm.html>; JS API
  request: <https://github.com/openmls/openmls/issues/487>; releases:
  <https://crates.io/crates/openmls>
* ts-mls: <https://github.com/LukaJCB/ts-mls>, <https://www.npmjs.com/package/ts-mls>
* AWS mls-rs: <https://github.com/awslabs/mls-rs>; webcrypto provider:
  <https://lib.rs/crates/mls-rs-crypto-webcrypto>
* Signal libsignal ("unsupported outside Signal"):
  <https://github.com/signalapp/libsignal>; WASM request (closed):
  <https://github.com/signalapp/libsignal/issues/350>;
  <https://www.npmjs.com/package/@signalapp/libsignal-client>
* Signal protocol 2016 academic audit coverage:
  <https://www.pindrop.com/article/audit-signal-protocol-finds-secure-trustworthy/>,
  <https://www.cyberscoop.com/signal-security-audit-encryption-facebook-messenger-whatsapp/>
* Discord DAVE (MLS-in-browser precedent): <https://github.com/discord/libdave>,
  <https://github.com/discord/dave-protocol>
* p2panda-encryption (custom, excluded): <https://github.com/p2panda/p2panda>,
  <https://p2panda.org/2025/02/24/group-encryption.html>
* IETF MLS WG (PQ ciphersuites, ratchet-tree conveyance drafts):
  <https://datatracker.ietf.org/wg/mls/documents/>
