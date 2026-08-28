// e2ee.ts — E2EE boundary, Web Crypto AES-GCM
// P2: 12B IV per message never reused (getRandomValues), 16B messageId per message, AAD = v1|channelId|messageId

export interface Crypto {
  encrypt(plain: string): Promise<string>;
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
  const raw = base64UrlDecode(b64);
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
    async encrypt(plain: string): Promise<string> {
      if (!isCryptoAvailable()) throw new Error("Web Crypto not available");
      const iv = new Uint8Array(12);
      crypto.getRandomValues(iv);
      const messageId = new Uint8Array(16);
      crypto.getRandomValues(messageId);
      const messageIdB64 = base64UrlEncode(messageId);
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
