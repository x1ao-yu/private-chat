// identity.ts — P6 anonymous session identity, Web Crypto Ed25519
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
  privateKey: CryptoKey;
  /** raw public key, unpadded base64url (Ed25519 raw = 32 bytes = 43 chars) */
  pubB64: string;
  /** short display fingerprint (pubB64 prefix) — presentation only; the full pk always travels in the payload */
  fp: string;
}

const IDENTITY_VERSION = "identity-v1";
const FP_LEN = 10;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

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
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const pubB64 = base64UrlEncode(new Uint8Array(raw));
  if (!isIdentityPubB64(pubB64)) throw new Error("unexpected public key encoding");
  return { publicKey: pair.publicKey, privateKey: pair.privateKey, pubB64, fp: fpOf(pubB64) };
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

/** Canonical signed data: binds the identity to room, envelope messageId, claimed nick and text. */
export function messageSigData(channelId: string, messageIdB64: string, nick: string, text: string): string {
  return `${IDENTITY_VERSION}|${channelId}|${messageIdB64}|${nick}|${text}`;
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
  return JSON.stringify({ t: "msg", v: 1, text, nick, pk: identity.pubB64, sig });
}

/**
 * Parse an inner message plaintext. Returns null for anything that is not a
 * signed message JSON (e.g. legacy raw text from clients without identity) —
 * callers render the plaintext as-is in that case.
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
  if (o.t !== "msg" || o.v !== 1) return null;
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
  return `${IDENTITY_VERSION}|nick|${channelId}|${nick}`;
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
