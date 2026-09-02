import { describe, it, expect } from "vitest";
import {
  noopCrypto,
  isCryptoAvailable,
  isRoomKeyB64,
  generateRoomKey,
  exportRoomKey,
  importRoomKey,
  importRoomKeyRaw,
  createAesGcmCrypto,
  isValidEnvelope,
  extractMessageIdB64,
  ReplayCache,
  wrapNewKey,
  unwrapNewKey,
  isValidRoomName,
  isValidNick,
  wrapRoomName,
  unwrapRoomName,
  wrapNick,
  unwrapNick,
} from "./e2ee.ts";

// base64url of exact-length bytes, for crafting synthetic envelopes
function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function envelope(ivLen: number, midLen: number, ctLen: number): string {
  return [
    b64url(crypto.getRandomValues(new Uint8Array(ivLen))),
    b64url(crypto.getRandomValues(new Uint8Array(midLen))),
    b64url(crypto.getRandomValues(new Uint8Array(ctLen))),
  ].join(".");
}

describe("e2ee noop", () => {
  it("encrypt/decrypt round-trip", async () => {
    const plain = "hello world";
    const cipher = await noopCrypto.encrypt(plain);
    expect(cipher).toBe(plain);
    const decrypted = await noopCrypto.decrypt(cipher);
    expect(decrypted).toBe(plain);
  });
});

describe("e2ee AES-GCM", () => {
  it("crypto available in test env", () => {
    expect(isCryptoAvailable()).toBe(true);
  });

  it("generate/export/import round-trip", async () => {
    const key = await generateRoomKey();
    const b64 = await exportRoomKey(key);
    expect(b64.length).toBeGreaterThan(40);
    const key2 = await importRoomKey(b64);
    const crypto1 = createAesGcmCrypto(key, "test-room-123");
    const crypto2 = createAesGcmCrypto(key2, "test-room-123");
    const ct = await crypto1.encrypt("hello");
    const pt = await crypto2.decrypt(ct);
    expect(pt).toBe("hello");
  });

  it("encrypt/decrypt round-trip with AAD", async () => {
    const key = await generateRoomKey();
    const crypto = createAesGcmCrypto(key, "room-abc");
    const plain = "hello E2EE world with AAD";
    const ct = await crypto.encrypt(plain);
    expect(ct).not.toBe(plain);
    expect(ct.split(".")).toHaveLength(3);
    const pt = await crypto.decrypt(ct);
    expect(pt).toBe(plain);
  });

  it("ciphertext differs from plaintext and server sees only ciphertext", async () => {
    const key = await generateRoomKey();
    const crypto = createAesGcmCrypto(key, "room-xyz");
    const plain = "secret message";
    const ct = await crypto.encrypt(plain);
    // server would see ct, not plain
    expect(ct).not.toContain(plain);
    // base64url parts
    const parts = ct.split(".");
    expect(parts[0].length).toBeGreaterThan(10); // iv 12B -> 16 b64url
    expect(parts[1].length).toBeGreaterThan(10); // messageId 16B -> 22 b64url
    expect(parts[2].length).toBeGreaterThan(10);
  });

  it("IV and messageId uniqueness", async () => {
    const key = await generateRoomKey();
    const crypto = createAesGcmCrypto(key, "room-unique");
    const ct1 = await crypto.encrypt("same plain");
    const ct2 = await crypto.encrypt("same plain");
    expect(ct1).not.toBe(ct2);
    const [iv1, mid1] = ct1.split(".");
    const [iv2, mid2] = ct2.split(".");
    expect(iv1).not.toBe(iv2);
    expect(mid1).not.toBe(mid2);
  });

  it("tamper detection fails decrypt", async () => {
    const key = await generateRoomKey();
    const crypto = createAesGcmCrypto(key, "room-tamper");
    const ct = await crypto.encrypt("tamper test");
    const parts = ct.split(".");
    // flip last char of ct
    const tamperedCt = parts[0] + "." + parts[1] + "." + parts[2].slice(0, -1) + (parts[2].slice(-1) === "A" ? "B" : "A");
    await expect(crypto.decrypt(tamperedCt)).rejects.toThrow();
  });

  it("AAD binding prevents cross-room decrypt", async () => {
    const key = await generateRoomKey();
    const cryptoA = createAesGcmCrypto(key, "room-A");
    const cryptoB = createAesGcmCrypto(key, "room-B");
    const ct = await cryptoA.encrypt("cross room");
    await expect(cryptoB.decrypt(ct)).rejects.toThrow();
  });

  it("AAD binding prevents cross-version or messageId tamper", async () => {
    const key = await generateRoomKey();
    const crypto = createAesGcmCrypto(key, "room-aad");
    const ct = await crypto.encrypt("aad test");
    const parts = ct.split(".");
    // tamper messageId
    const fakeMid = parts[1].slice(0, -1) + (parts[1].slice(-1) === "A" ? "B" : "A");
    const tampered = `${parts[0]}.${fakeMid}.${parts[2]}`;
    await expect(crypto.decrypt(tampered)).rejects.toThrow();
  });

  it("empty string round-trip", async () => {
    const key = await generateRoomKey();
    const crypto = createAesGcmCrypto(key, "room-empty");
    const ct = await crypto.encrypt("");
    const pt = await crypto.decrypt(ct);
    expect(pt).toBe("");
  });
});

describe("room key validation (P3)", () => {
  const KEY_OK = "A".repeat(43); // valid charset, valid length

  it("exported key is exactly 43 chars base64url", async () => {
    const b64 = await exportRoomKey(await generateRoomKey());
    expect(b64.length).toBe(43);
    expect(isRoomKeyB64(b64)).toBe(true);
  });

  it("rejects std-base64 charset (+ / =)", async () => {
    await expect(importRoomKey("+".repeat(43))).rejects.toThrow(/invalid key format/);
    await expect(importRoomKey("/".repeat(43))).rejects.toThrow(/invalid key format/);
    await expect(importRoomKey(KEY_OK.slice(0, 42) + "=")).rejects.toThrow(/invalid key format/);
  });

  it("rejects illegal characters", async () => {
    await expect(importRoomKey("!".repeat(43))).rejects.toThrow(/invalid key format/);
    await expect(importRoomKey(KEY_OK.slice(0, 42) + " ")).rejects.toThrow(/invalid key format/);
  });

  it("rejects wrong length", async () => {
    await expect(importRoomKey("A".repeat(42))).rejects.toThrow(/invalid key format/);
    await expect(importRoomKey("A".repeat(44))).rejects.toThrow(/invalid key format/);
    await expect(importRoomKey("A")).rejects.toThrow(/invalid key format/);
  });

  it("rejects empty input", async () => {
    await expect(importRoomKey("")).rejects.toThrow(/invalid key format/);
  });

  it("trims surrounding whitespace before validating", async () => {
    const b64 = await exportRoomKey(await generateRoomKey());
    const key = await importRoomKey(`  ${b64}  `);
    expect(key.type).toBe("secret");
  });

  it("imported key is not extractable", async () => {
    const b64 = await exportRoomKey(await generateRoomKey());
    const key = await importRoomKey(b64);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("well-formed but wrong key fails decrypt (not detectable at import)", async () => {
    const rawA = crypto.getRandomValues(new Uint8Array(32));
    const rawB = crypto.getRandomValues(new Uint8Array(32));
    const keyA = await importRoomKeyRaw(rawA);
    const keyB = await importRoomKeyRaw(rawB);
    const cryptoA = createAesGcmCrypto(keyA, "room-wrong-key");
    const cryptoB = createAesGcmCrypto(keyB, "room-wrong-key");
    const ct = await cryptoA.encrypt("for A only");
    await expect(cryptoB.decrypt(ct)).rejects.toThrow();
  });
});

describe("envelope validation (P5)", () => {
  it("accepts a real encrypt() envelope", async () => {
    const crypto = createAesGcmCrypto(await generateRoomKey(), "room-env");
    expect(isValidEnvelope(await crypto.encrypt("check"))).toBe(true);
  });

  it("accepts exact-size synthetic envelopes (iv 12B, mid 16B, ct >= 16B)", () => {
    expect(isValidEnvelope(envelope(12, 16, 16))).toBe(true);
    expect(isValidEnvelope(envelope(12, 16, 64))).toBe(true);
  });

  it("rejects wrong part count", () => {
    expect(isValidEnvelope("only.two")).toBe(false);
    expect(isValidEnvelope("a.b.c.d")).toBe(false);
    expect(isValidEnvelope("")).toBe(false);
  });

  it("rejects illegal charset", () => {
    const good = envelope(12, 16, 16);
    expect(isValidEnvelope("+" + good.slice(1))).toBe(false);
    expect(isValidEnvelope(good.slice(0, -1) + "/")).toBe(false);
  });

  it("rejects wrong iv/mid/ct byte lengths", () => {
    expect(isValidEnvelope(envelope(11, 16, 16))).toBe(false); // iv
    expect(isValidEnvelope(envelope(13, 16, 16))).toBe(false);
    expect(isValidEnvelope(envelope(12, 15, 16))).toBe(false); // mid
    expect(isValidEnvelope(envelope(12, 17, 16))).toBe(false);
    expect(isValidEnvelope(envelope(12, 16, 15))).toBe(false); // ct < 16B (tag)
    expect(isValidEnvelope(envelope(12, 16, 0))).toBe(false);
  });

  it("extractMessageIdB64 returns middle part or null", async () => {
    const crypto = createAesGcmCrypto(await generateRoomKey(), "room-mid");
    const ct = await crypto.encrypt("mid");
    const parts = ct.split(".");
    expect(extractMessageIdB64(ct)).toBe(parts[1]);
    expect(extractMessageIdB64("a.b")).toBeNull();
    expect(extractMessageIdB64("a.b.c.d")).toBeNull();
  });
});

describe("ReplayCache (P5)", () => {
  it("add/has/size basics", () => {
    const cache = new ReplayCache(3);
    expect(cache.has("a")).toBe(false);
    cache.add("a");
    expect(cache.has("a")).toBe(true);
    expect(cache.size()).toBe(1);
  });

  it("duplicate add is a no-op", () => {
    const cache = new ReplayCache(3);
    cache.add("a");
    cache.add("a");
    expect(cache.size()).toBe(1);
  });

  it("evicts oldest beyond max", () => {
    const cache = new ReplayCache(3);
    cache.add("a");
    cache.add("b");
    cache.add("c");
    cache.add("d");
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.has("d")).toBe(true);
    expect(cache.size()).toBe(3);
  });

  it("clear resets everything", () => {
    const cache = new ReplayCache(3);
    cache.add("a");
    cache.add("b");
    cache.clear();
    expect(cache.has("a")).toBe(false);
    expect(cache.size()).toBe(0);
  });
});

describe("key rotation wrap/unwrap (P5)", () => {
  it("wrapNewKey/unwrapNewKey round-trip", async () => {
    const oldCrypto = createAesGcmCrypto(await generateRoomKey(), "room-rot");
    const newKeyB64 = await exportRoomKey(await generateRoomKey());
    const wrapped = await wrapNewKey(oldCrypto, newKeyB64);
    expect(isValidEnvelope(wrapped)).toBe(true);
    expect(wrapped).not.toContain(newKeyB64);
    await expect(unwrapNewKey(oldCrypto, wrapped)).resolves.toBe(newKeyB64);
  });

  it("unwrapNewKey rejects non-JSON plaintext", async () => {
    const crypto = createAesGcmCrypto(await generateRoomKey(), "room-rot2");
    const wrapped = await crypto.encrypt("not json at all");
    await expect(unwrapNewKey(crypto, wrapped)).rejects.toThrow(/invalid key_update payload/);
  });

  it("unwrapNewKey rejects wrong version", async () => {
    const crypto = createAesGcmCrypto(await generateRoomKey(), "room-rot3");
    const wrapped = await crypto.encrypt(JSON.stringify({ k: "A".repeat(43), v: 2 }));
    await expect(unwrapNewKey(crypto, wrapped)).rejects.toThrow(/invalid key_update version/);
  });

  it("unwrapNewKey rejects malformed key", async () => {
    const crypto = createAesGcmCrypto(await generateRoomKey(), "room-rot4");
    const wrapped = await crypto.encrypt(JSON.stringify({ k: "short", v: 1 }));
    await expect(unwrapNewKey(crypto, wrapped)).rejects.toThrow(/invalid wrapped key/);
  });

  it("unwrapNewKey fails with wrong room key", async () => {
    const cryptoA = createAesGcmCrypto(await generateRoomKey(), "room-rot5");
    const cryptoB = createAesGcmCrypto(await generateRoomKey(), "room-rot5");
    const wrapped = await wrapNewKey(cryptoA, await exportRoomKey(await generateRoomKey()));
    await expect(unwrapNewKey(cryptoB, wrapped)).rejects.toThrow();
  });

  it("wrapNewKey rejects invalid new key format", async () => {
    const crypto = createAesGcmCrypto(await generateRoomKey(), "room-rot6");
    await expect(wrapNewKey(crypto, "A".repeat(42))).rejects.toThrow(/invalid new key format/);
  });
});

describe("room name wrap/unwrap", () => {
  it("round-trip trims surrounding whitespace", async () => {
    const crypto = createAesGcmCrypto(await generateRoomKey(), "room-name1");
    const wrapped = await wrapRoomName(crypto, "  My Room  ");
    expect(isValidEnvelope(wrapped)).toBe(true);
    await expect(unwrapRoomName(crypto, wrapped)).resolves.toEqual({ name: "My Room", initial: false });
  });

  it("round-trips initial flag for re-announcements", async () => {
    const crypto = createAesGcmCrypto(await generateRoomKey(), "room-name-init");
    const wrapped = await wrapRoomName(crypto, "My Room", { initial: true });
    await expect(unwrapRoomName(crypto, wrapped)).resolves.toEqual({ name: "My Room", initial: true });
  });

  it("isValidRoomName boundaries", () => {
    expect(isValidRoomName("a")).toBe(true);
    expect(isValidRoomName("a".repeat(32))).toBe(true);
    expect(isValidRoomName("  padded  ")).toBe(true); // trims before length check
    expect(isValidRoomName("")).toBe(false);
    expect(isValidRoomName("   ")).toBe(false);
    expect(isValidRoomName("a".repeat(33))).toBe(false);
    expect(isValidRoomName("a\nb")).toBe(false);
  });

  it("wrapRoomName rejects invalid names", async () => {
    const crypto = createAesGcmCrypto(await generateRoomKey(), "room-name2");
    await expect(wrapRoomName(crypto, "")).rejects.toThrow(/invalid room name/);
    await expect(wrapRoomName(crypto, "a".repeat(33))).rejects.toThrow(/invalid room name/);
    await expect(wrapRoomName(crypto, "a\nb")).rejects.toThrow(/invalid room name/);
  });

  it("unwrapRoomName rejects wrong t/v/type/length", async () => {
    const crypto = createAesGcmCrypto(await generateRoomKey(), "room-name3");
    const wrongT = await crypto.encrypt(JSON.stringify({ t: "nick", v: 1, name: "x" }));
    await expect(unwrapRoomName(crypto, wrongT)).rejects.toThrow(/invalid room_name fields/);
    const wrongV = await crypto.encrypt(JSON.stringify({ t: "room_name", v: 2, name: "x" }));
    await expect(unwrapRoomName(crypto, wrongV)).rejects.toThrow(/invalid room_name fields/);
    const notString = await crypto.encrypt(JSON.stringify({ t: "room_name", v: 1, name: 5 }));
    await expect(unwrapRoomName(crypto, notString)).rejects.toThrow(/invalid room_name fields/);
    const tooLong = await crypto.encrypt(JSON.stringify({ t: "room_name", v: 1, name: "a".repeat(33) }));
    await expect(unwrapRoomName(crypto, tooLong)).rejects.toThrow(/invalid room_name fields/);
    const notJson = await crypto.encrypt("plain text");
    await expect(unwrapRoomName(crypto, notJson)).rejects.toThrow(/invalid room_name payload/);
  });
});

describe("nick wrap/unwrap", () => {
  it("round-trip trims surrounding whitespace", async () => {
    const crypto = createAesGcmCrypto(await generateRoomKey(), "room-nick1");
    const wrapped = await wrapNick(crypto, "  alice  ");
    expect(isValidEnvelope(wrapped)).toBe(true);
    await expect(unwrapNick(crypto, wrapped)).resolves.toBe("alice");
  });

  it("isValidNick boundaries", () => {
    expect(isValidNick("a")).toBe(true);
    expect(isValidNick("a".repeat(20))).toBe(true);
    expect(isValidNick("  bob  ")).toBe(true); // trims before length check
    expect(isValidNick("")).toBe(false);
    expect(isValidNick("   ")).toBe(false);
    expect(isValidNick("a".repeat(21))).toBe(false);
    expect(isValidNick("a\nb")).toBe(false);
  });

  it("wrapNick rejects invalid nicks", async () => {
    const crypto = createAesGcmCrypto(await generateRoomKey(), "room-nick2");
    await expect(wrapNick(crypto, "")).rejects.toThrow(/invalid nick/);
    await expect(wrapNick(crypto, "a".repeat(21))).rejects.toThrow(/invalid nick/);
    await expect(wrapNick(crypto, "a\nb")).rejects.toThrow(/invalid nick/);
  });

  it("unwrapNick rejects wrong t/v/type/length", async () => {
    const crypto = createAesGcmCrypto(await generateRoomKey(), "room-nick3");
    const wrongT = await crypto.encrypt(JSON.stringify({ t: "room_name", v: 1, nick: "x" }));
    await expect(unwrapNick(crypto, wrongT)).rejects.toThrow(/invalid nick fields/);
    const wrongV = await crypto.encrypt(JSON.stringify({ t: "nick", v: 2, nick: "x" }));
    await expect(unwrapNick(crypto, wrongV)).rejects.toThrow(/invalid nick fields/);
    const notString = await crypto.encrypt(JSON.stringify({ t: "nick", v: 1, nick: 5 }));
    await expect(unwrapNick(crypto, notString)).rejects.toThrow(/invalid nick fields/);
    const tooLong = await crypto.encrypt(JSON.stringify({ t: "nick", v: 1, nick: "a".repeat(21) }));
    await expect(unwrapNick(crypto, tooLong)).rejects.toThrow(/invalid nick fields/);
    const notJson = await crypto.encrypt("plain text");
    await expect(unwrapNick(crypto, notJson)).rejects.toThrow(/invalid nick payload/);
  });
});
