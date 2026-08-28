import { describe, it, expect } from "vitest";
import { noopCrypto } from "./e2ee.ts";

describe("e2ee noop", () => {
  it("encrypt/decrypt round-trip", async () => {
    const plain = "hello world";
    const cipher = await noopCrypto.encrypt(plain);
    expect(cipher).toBe(plain);
    const decrypted = await noopCrypto.decrypt(cipher);
    expect(decrypted).toBe(plain);
  });
});
