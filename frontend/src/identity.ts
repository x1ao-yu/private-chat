// identity.ts — P6 anonymous session identity, Web Crypto Ed25519
// Signed-data encoding is identity-v2: variable-length fields are UTF-8
// length-prefixed so a signature cannot be re-split across field boundaries
// (the identity-v1 flaw). v1 claims are detected and never trusted.
// The keypair lives in tab memory only (like room keys): never persisted, never
// sent to the server except the public key inside the E2EE payload — the server
// still sees ciphertext only. It is a session identity by design: it disappears
// when the tab closes or refreshes, and must never be presented as permanent.

import {
  isCryptoAvailable,
  isValidNick,
  isRoomKeyB64,
  base64UrlEncode,
  base64UrlDecode,
  type Crypto,
} from "./e2ee.ts";

export interface Identity {
  publicKey: CryptoKey;
  /** non-extractable: re-imported from pkcs8 after generation (see below) */
  privateKey: CryptoKey;
  /** raw public key, unpadded base64url (Ed25519 raw = 32 bytes = 43 chars) */
  pubB64: string;
  /** short display fingerprint (pubB64 prefix) — presentation only; the full pk always travels in the payload */
  fp: string;
}

const IDENTITY_VERSION = "identity-v2";
const FP_LEN = 10;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

const utf8 = new TextEncoder();

/**
 * Length-prefix a variable field so it cannot absorb the `|` field separator.
 * Byte length (not UTF-16 code units) because the signature covers the UTF-8
 * encoding of the frame. Without this, `("Alice", "a|b")` and `("Alice|a", "b")`
 * produce the same signed string (identity-v1 flaw, fixed in v2).
 */
function frame(field: string): string {
  return `${utf8.encode(field).length}:${field}`;
}

let ed25519Available: boolean | null = null;

/** True when Web Crypto + Ed25519 are usable (async capability probe, cached). */
export async function isIdentityAvailable(): Promise<boolean> {
  if (!isCryptoAvailable()) return false;
  if (ed25519Available !== null) return ed25519Available;
  try {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    ed25519Available = !!pair.publicKey && !!pair.privateKey;
  } catch {
    ed25519Available = false;
  }
  return ed25519Available;
}

export function isIdentityPubB64(s: string): boolean {
  // Ed25519 raw public key is 32 bytes — same 43-char unpadded base64url shape as room keys
  return isRoomKeyB64(s);
}

export function fpOf(pubB64: string): string {
  return pubB64.slice(0, FP_LEN);
}

export async function generateIdentity(): Promise<Identity> {
  if (!(await isIdentityAvailable())) throw new Error("Ed25519 not available");
  // Web Crypto applies a single extractable flag to the whole Ed25519 pair,
  // and we must export the public key (raw) into the payload. So the pair is
  // generated extractable, the private key is immediately re-imported as
  // NON-extractable from its one-time pkcs8 export, and the original
  // extractable key is dropped. The pkcs8 bytes transit JS memory exactly
  // once — never stored, never sent.
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const rawPub = await crypto.subtle.exportKey("raw", pair.publicKey);
  const pubB64 = base64UrlEncode(new Uint8Array(rawPub));
  if (!isIdentityPubB64(pubB64)) throw new Error("unexpected public key encoding");
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8 as BufferSource,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return { publicKey: pair.publicKey, privateKey, pubB64, fp: fpOf(pubB64) };
}

export async function signIdentity(privateKey: CryptoKey, data: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(data) as BufferSource,
  );
  return base64UrlEncode(new Uint8Array(sig));
}

export async function verifyIdentity(pubB64: string, sigB64: string, data: string): Promise<boolean> {
  if (!isIdentityPubB64(pubB64)) return false;
  if (!B64URL_RE.test(sigB64)) return false;
  try {
    const sig = base64UrlDecode(sigB64);
    if (sig.length !== 64) return false; // Ed25519 signatures are exactly 64 bytes
    const pub = await crypto.subtle.importKey(
      "raw",
      base64UrlDecode(pubB64) as BufferSource,
      { name: "Ed25519" },
      true,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      pub,
      sig as BufferSource,
      new TextEncoder().encode(data) as BufferSource,
    );
  } catch {
    return false;
  }
}

// ---- chat message signing (inner plaintext JSON, {t,v,...} convention) ----

export type SignedMessagePayload = {
  text: string;
  nick: string;
  pk: string;
  sig: string;
};

/**
 * Canonical signed data: binds identity to room, envelope messageId, claimed
 * nick and text. `channelId`/`messageIdB64` are charset-restricted so need no
 * frame; `nick`/`text` are user-controlled and get length-prefixed. The `msg`
 * tag domain-separates this from {@link nickSigData}.
 */
export function messageSigData(channelId: string, messageIdB64: string, nick: string, text: string): string {
  return `${IDENTITY_VERSION}|msg|${channelId}|${messageIdB64}|${frame(nick)}|${frame(text)}`;
}

/** Inner plaintext for a signed chat message; the caller encrypts it with the room key. */
export async function wrapSignedMessage(
  identity: Identity,
  channelId: string,
  messageIdB64: string,
  text: string,
  nick: string,
): Promise<string> {
  const sig = await signIdentity(identity.privateKey, messageSigData(channelId, messageIdB64, nick, text));
  return JSON.stringify({ t: "msg", v: 2, text, nick, pk: identity.pubB64, sig });
}

/**
 * Parse an inner message plaintext. Returns null for anything that is not a
 * signed v2 message (e.g. legacy raw text from clients without identity, or a
 * stale v1 envelope) — callers handle those via {@link staleSignedMessagePk}
 * and then render the plaintext as-is.
 */
export function parseSignedMessage(plain: string): SignedMessagePayload | null {
  if (!plain.startsWith("{")) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(plain);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.t !== "msg" || o.v !== 2) return null;
  if (typeof o.text !== "string") return null;
  if (typeof o.nick !== "string" || !isValidNick(o.nick)) return null;
  if (typeof o.pk !== "string" || !isIdentityPubB64(o.pk)) return null;
  if (typeof o.sig !== "string" || !B64URL_RE.test(o.sig)) return null;
  return { text: o.text, nick: o.nick, pk: o.pk, sig: o.sig };
}

export async function verifySignedMessage(
  channelId: string,
  messageIdB64: string,
  m: SignedMessagePayload,
): Promise<boolean> {
  return verifyIdentity(m.pk, m.sig, messageSigData(channelId, messageIdB64, m.nick, m.text));
}

/**
 * Recognize an identity-v1 signed message and return its claimed public key.
 *
 * v1 joined `nick` and `text` with an unescaped `|`, so one valid v1 signature
 * could be re-split into a different (nick, text) pair by anyone holding the
 * room key. v1 claims are therefore never trusted as verified; callers surface
 * them as an explicit "upgrade your client" state rather than silently
 * dropping them. Returns null for anything that is not a well-formed v1 claim,
 * including legacy unsigned raw text.
 */
export function staleSignedMessagePk(plain: string): string | null {
  if (!plain.startsWith("{")) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(plain);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.t !== "msg" || o.v !== 1) return null;
  if (typeof o.sig !== "string" || !B64URL_RE.test(o.sig)) return null;
  if (typeof o.pk !== "string" || !isIdentityPubB64(o.pk)) return null;
  return o.pk;
}

/**
 * True when the plaintext is a structured inner payload (JSON object with a
 * string "t" type tag) that this client cannot interpret as a signed message —
 * e.g. from a newer client version, or a malformed protocol-internal format.
 * Callers must ignore such payloads and never render the raw JSON.
 */
export function isUnknownStructuredPayload(plain: string): boolean {
  if (!plain.startsWith("{")) return false;
  let obj: unknown;
  try {
    obj = JSON.parse(plain);
  } catch {
    return false;
  }
  if (!obj || typeof obj !== "object") return false;
  return typeof (obj as Record<string, unknown>).t === "string";
}

// ---- nickname signing ----

/** Canonical signed data for a nick claim: binds the identity to room and nick. */
export function nickSigData(channelId: string, nick: string): string {
  return `${IDENTITY_VERSION}|nick|${channelId}|${frame(nick)}`;
}

/**
 * Build a signed nickname update and encrypt it with the room key — returns a
 * ready-to-send E2EE envelope (same contract as wrapNick). The signature only
 * covers the inner JSON; the room crypto encrypts the whole thing.
 */
export async function wrapSignedNick(
  identity: Identity,
  crypto: Crypto,
  channelId: string,
  nick: string,
): Promise<string> {
  const n = nick.trim();
  if (!isValidNick(n)) throw new Error("invalid nick (1-20 chars, no newline)");
  const sig = await signIdentity(identity.privateKey, nickSigData(channelId, n));
  // Inner JSON stays v:1 on purpose: `unwrapNick` is the shared receive parser for
  // both signed and unsigned nick claims, and the trust decision here is carried by
  // the signature encoding (identity-v2 framing), not by this field. A pre-v2 signed
  // nick therefore fails `verifySignedNick` and is dropped visibly, which is the
  // behaviour we want; bumping v would instead reject well-formed unsigned claims.
  return crypto.encrypt(JSON.stringify({ t: "nick", v: 1, nick: n, pk: identity.pubB64, sig }));
}

export async function verifySignedNick(
  channelId: string,
  nick: string,
  pk: string,
  sig: string,
): Promise<boolean> {
  return verifyIdentity(pk, sig, nickSigData(channelId, nick));
}
