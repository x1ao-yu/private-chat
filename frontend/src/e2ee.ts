// e2ee.ts — E2EE boundary, Web Crypto AES-GCM
// P2: 12B IV per message never reused (getRandomValues), 16B messageId per message, AAD = v1|channelId|messageId

export interface EncryptOptions {
  /** pre-set message id (base64url, 16 bytes) — for plaintexts that must bind to it (P6 identity signatures) */
  messageIdB64?: string;
}

export interface Crypto {
  encrypt(plain: string, opts?: EncryptOptions): Promise<string>;
  decrypt(cipher: string): Promise<string>;
}

export const noopCrypto: Crypto = {
  async encrypt(plain: string): Promise<string> {
    return plain;
  },
  async decrypt(cipher: string): Promise<string> {
    return cipher;
  },
};

export function isCryptoAvailable(): boolean {
  return (
    typeof globalThis.crypto !== "undefined" &&
    !!globalThis.crypto.subtle &&
    typeof globalThis.crypto.getRandomValues === "function"
  );
}

// a 32-byte key encoded as unpadded base64url is exactly 43 chars
export function isRoomKeyB64(s: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(s);
}

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function isValidEnvelope(payload: string): boolean {
  const parts = payload.split(".");
  if (parts.length !== 3) return false;
  const [ivB64, midB64, ctB64] = parts;
  if (!ivB64 || !midB64 || !ctB64) return false;
  if (!B64URL_RE.test(ivB64) || !B64URL_RE.test(midB64) || !B64URL_RE.test(ctB64)) return false;
  try {
    const iv = base64UrlDecode(ivB64);
    const mid = base64UrlDecode(midB64);
    const ct = base64UrlDecode(ctB64);
    if (iv.length !== 12) return false;
    if (mid.length !== 16) return false;
    if (ct.length < 16) return false; // at least tag
  } catch {
    return false;
  }
  return true;
}

export function extractMessageIdB64(payload: string): string | null {
  const parts = payload.split(".");
  if (parts.length !== 3) return null;
  return parts[1] || null;
}

// Simple LRU dedup for replay protection (per-channel, in-memory)
export class ReplayCache {
  private seen = new Set<string>();
  private queue: string[] = [];
  private max: number;
  constructor(max = 1000) {
    this.max = max;
  }
  has(id: string): boolean {
    return this.seen.has(id);
  }
  add(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.queue.push(id);
    if (this.queue.length > this.max) {
      const old = this.queue.shift()!;
      this.seen.delete(old);
    }
  }
  clear(): void {
    this.seen.clear();
    this.queue = [];
  }
  size(): number {
    return this.seen.size;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = btoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(s: string): Uint8Array {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export { base64UrlEncode, base64UrlDecode };

/** Fresh 16-byte message id as base64url — lets callers bind a signature to the envelope id (P6). */
export function newMessageIdB64(): string {
  const messageId = new Uint8Array(16);
  crypto.getRandomValues(messageId);
  return base64UrlEncode(messageId);
}

export async function generateRoomKey(): Promise<CryptoKey> {
  if (!isCryptoAvailable()) throw new Error("Web Crypto not available (need HTTPS or localhost)");
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function exportRoomKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return base64UrlEncode(new Uint8Array(raw));
}

export async function importRoomKey(b64: string): Promise<CryptoKey> {
  if (!isCryptoAvailable()) throw new Error("Web Crypto not available");
  const key = b64.trim();
  if (!isRoomKeyB64(key)) throw new Error("invalid key format (expect 43 chars base64url)");
  const raw = base64UrlDecode(key);
  if (raw.length !== 32) throw new Error("invalid key length");
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

// For testing with raw bytes
export async function importRoomKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("invalid key length");
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export function createAesGcmCrypto(key: CryptoKey, channelId: string): Crypto {
  if (!channelId || !/^[a-zA-Z0-9_-]{1,64}$/.test(channelId)) {
    throw new Error("invalid channelId for AAD");
  }
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  return {
    async encrypt(plain: string, opts?: EncryptOptions): Promise<string> {
      if (!isCryptoAvailable()) throw new Error("Web Crypto not available");
      const iv = new Uint8Array(12);
      crypto.getRandomValues(iv);
      let messageIdB64: string;
      if (opts?.messageIdB64 !== undefined) {
        if (!B64URL_RE.test(opts.messageIdB64)) throw new Error("invalid preset messageIdB64");
        const mid = base64UrlDecode(opts.messageIdB64);
        if (mid.length !== 16) throw new Error("invalid preset messageIdB64 length");
        messageIdB64 = opts.messageIdB64;
      } else {
        const messageId = new Uint8Array(16);
        crypto.getRandomValues(messageId);
        messageIdB64 = base64UrlEncode(messageId);
      }
      const aad = enc.encode(`v1|${channelId}|${messageIdB64}`);
      const ctBuffer = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
        key,
        enc.encode(plain) as BufferSource,
      );
      const ct = new Uint8Array(ctBuffer);
      return `${base64UrlEncode(iv)}.${messageIdB64}.${base64UrlEncode(ct)}`;
    },

    async decrypt(cipher: string): Promise<string> {
      if (!isCryptoAvailable()) throw new Error("Web Crypto not available");
      const parts = cipher.split(".");
      if (parts.length !== 3) throw new Error("invalid cipher format");
      const [ivB64, messageIdB64, ctB64] = parts;
      const iv = base64UrlDecode(ivB64);
      const messageId = base64UrlDecode(messageIdB64);
      if (iv.length !== 12) throw new Error("invalid iv length");
      if (messageId.length !== 16) throw new Error("invalid messageId length");
      const aad = enc.encode(`v1|${channelId}|${messageIdB64}`);
      const ct = base64UrlDecode(ctB64);
      const plainBuffer = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
        key,
        ct as BufferSource,
      );
      return dec.decode(plainBuffer);
    },
  };
}

// Key rotation helpers: wrap new room key with old key's Crypto (P5)
export async function wrapNewKey(crypto: Crypto, newKeyB64: string): Promise<string> {
  if (!isRoomKeyB64(newKeyB64)) throw new Error("invalid new key format");
  const plain = JSON.stringify({ k: newKeyB64, v: 1 });
  return crypto.encrypt(plain);
}

export async function unwrapNewKey(crypto: Crypto, payload: string): Promise<string> {
  const plain = await crypto.decrypt(payload);
  let obj: unknown;
  try {
    obj = JSON.parse(plain);
  } catch {
    throw new Error("invalid key_update payload");
  }
  if (!obj || typeof obj !== "object" || (obj as { v?: unknown }).v !== 1) {
    throw new Error("invalid key_update version");
  }
  const k = (obj as { k?: unknown }).k;
  if (typeof k !== "string" || !isRoomKeyB64(k)) throw new Error("invalid wrapped key");
  return k;
}

// Display name helpers (per-room, E2EE sync, protocol fields t/v/name/nick)
export function isValidRoomName(s: string): boolean {
  const t = s.trim();
  return t.length >= 1 && t.length <= 32 && !t.includes("\n");
}
export function isValidNick(s: string): boolean {
  const t = s.trim();
  return t.length >= 1 && t.length <= 20 && !t.includes("\n");
}

export async function wrapRoomName(crypto: Crypto, name: string, opts?: { initial?: boolean }): Promise<string> {
  const n = name.trim();
  if (!isValidRoomName(n)) throw new Error("invalid room name (1-32 chars, no newline)");
  const plain = JSON.stringify({ t: "room_name", v: 1, name: n, ...(opts?.initial ? { initial: true } : {}) });
  return crypto.encrypt(plain);
}
export async function unwrapRoomName(crypto: Crypto, payload: string): Promise<{ name: string; initial: boolean }> {
  const plain = await crypto.decrypt(payload);
  let obj: unknown;
  try {
    obj = JSON.parse(plain);
  } catch {
    throw new Error("invalid room_name payload");
  }
  if (!obj || typeof obj !== "object") throw new Error("invalid room_name payload");
  const o = obj as { t?: unknown; v?: unknown; name?: unknown; initial?: unknown };
  if (o.t !== "room_name" || o.v !== 1 || typeof o.name !== "string" || !isValidRoomName(o.name)) {
    throw new Error("invalid room_name fields");
  }
  return { name: o.name.trim(), initial: o.initial === true };
}

export async function wrapNick(crypto: Crypto, nick: string): Promise<string> {
  const n = nick.trim();
  if (!isValidNick(n)) throw new Error("invalid nick (1-20 chars, no newline)");
  const plain = JSON.stringify({ t: "nick", v: 1, nick: n });
  return crypto.encrypt(plain);
}
export type UnwrappedNick = {
  nick: string;
  /** identity public key (43-char base64url) when the claim is signed, else null (legacy client) */
  pk: string | null;
  /** Ed25519 signature (base64url) over "identity-v1|nick|<channelId>|<nick>", else null */
  sig: string | null;
};

export async function unwrapNick(crypto: Crypto, payload: string): Promise<UnwrappedNick> {
  const plain = await crypto.decrypt(payload);
  let obj: unknown;
  try {
    obj = JSON.parse(plain);
  } catch {
    throw new Error("invalid nick payload");
  }
  if (!obj || typeof obj !== "object") throw new Error("invalid nick payload");
  const o = obj as { t?: unknown; v?: unknown; nick?: unknown; pk?: unknown; sig?: unknown };
  if (o.t !== "nick" || o.v !== 1 || typeof o.nick !== "string" || !isValidNick(o.nick)) {
    throw new Error("invalid nick fields");
  }
  // pk has the same 32-byte / 43-char base64url shape as a room key; malformed
  // identity fields are normalized to null (the caller treats that as unsigned)
  const pk = typeof o.pk === "string" && isRoomKeyB64(o.pk) ? o.pk : null;
  const sig = typeof o.sig === "string" && B64URL_RE.test(o.sig) ? o.sig : null;
  return { nick: o.nick.trim(), pk, sig };
}
