import { describe, it, expect } from "vitest";
import {
  noopCrypto,
  isCryptoAvailable,
  generateRoomKey,
  exportRoomKey,
  importRoomKey,
  createAesGcmCrypto,
} from "./e2ee.ts";

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
