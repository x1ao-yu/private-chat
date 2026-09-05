import { describe, it, expect } from "vitest";
import {
  isIdentityAvailable,
  isIdentityPubB64,
  fpOf,
  generateIdentity,
  signIdentity,
  verifyIdentity,
  messageSigData,
  wrapSignedMessage,
  parseSignedMessage,
  verifySignedMessage,
  nickSigData,
  wrapSignedNick,
  verifySignedNick,
  type Identity,
} from "./identity.ts";
import { isValidNick, noopCrypto, createAesGcmCrypto, generateRoomKey, isValidEnvelope } from "./e2ee.ts";

const CH = "room-test-1";
const MID = "AAAAAAAAAAAAAAAAAAAAAA"; // 16 bytes as base64url (22 chars)

async function makeIdentity(): Promise<Identity> {
  return generateIdentity();
}

describe("identity availability (P6)", () => {
  it("reports Ed25519 available in the test environment", async () => {
    expect(await isIdentityAvailable()).toBe(true);
  });
});

describe("identity key generation (P6)", () => {
  it("generates a 43-char base64url public key and a 10-char fingerprint", async () => {
    const id = await makeIdentity();
    expect(isIdentityPubB64(id.pubB64)).toBe(true);
    expect(id.pubB64).toHaveLength(43);
    expect(id.fp).toBe(id.pubB64.slice(0, 10));
    expect(fpOf(id.pubB64)).toBe(id.fp);
  });

  it("generates distinct keypairs on each call", async () => {
    const a = await makeIdentity();
    const b = await makeIdentity();
    expect(a.pubB64).not.toBe(b.pubB64);
  });

  it("rejects malformed public keys", () => {
    expect(isIdentityPubB64("short")).toBe(false);
    expect(isIdentityPubB64("A".repeat(43) + "!")).toBe(false);
  });
});

describe("identity sign/verify (P6)", () => {
  it("round-trips a signature", async () => {
    const id = await makeIdentity();
    const sig = await signIdentity(id.privateKey, "hello");
    await expect(verifyIdentity(id.pubB64, sig, "hello")).resolves.toBe(true);
  });

  it("rejects a signature over tampered data", async () => {
    const id = await makeIdentity();
    const sig = await signIdentity(id.privateKey, "hello");
    await expect(verifyIdentity(id.pubB64, sig, "heilo")).resolves.toBe(false);
  });

  it("rejects a signature verified against a different public key", async () => {
    const a = await makeIdentity();
    const b = await makeIdentity();
    const sig = await signIdentity(a.privateKey, "hello");
    await expect(verifyIdentity(b.pubB64, sig, "hello")).resolves.toBe(false);
  });

  it("rejects malformed signatures and keys", async () => {
    const id = await makeIdentity();
    await expect(verifyIdentity("bad-key", "sig", "hello")).resolves.toBe(false);
    await expect(verifyIdentity(id.pubB64, "not base64!!", "hello")).resolves.toBe(false);
    await expect(verifyIdentity(id.pubB64, "AAAA", "hello")).resolves.toBe(false); // wrong length
  });
});

describe("signed message wrap/parse (P6)", () => {
  it("wraps, parses and verifies a signed message", async () => {
    const id = await makeIdentity();
    const inner = await wrapSignedMessage(id, CH, MID, "hi there", "alice");
    const parsed = parseSignedMessage(inner);
    expect(parsed).not.toBeNull();
    expect(parsed!.text).toBe("hi there");
    expect(parsed!.nick).toBe("alice");
    expect(parsed!.pk).toBe(id.pubB64);
    await expect(verifySignedMessage(CH, MID, parsed!)).resolves.toBe(true);
  });

  it("binds the signature to channelId, messageId, nick and text", async () => {
    const id = await makeIdentity();
    const parsed = parseSignedMessage(await wrapSignedMessage(id, CH, MID, "hi", "alice"))!;
    await expect(verifySignedMessage("other-room", MID, parsed)).resolves.toBe(false);
    await expect(verifySignedMessage(CH, "BBBBBBBBBBBBBBBBBBBBBB", parsed)).resolves.toBe(false);
    await expect(verifySignedMessage(CH, MID, { ...parsed, text: "evil" })).resolves.toBe(false);
    await expect(verifySignedMessage(CH, MID, { ...parsed, nick: "bob" })).resolves.toBe(false);
  });

  it("messageSigData is stable and includes all binding parts", () => {
    expect(messageSigData(CH, MID, "alice", "hi")).toBe(`identity-v1|${CH}|${MID}|alice|hi`);
  });

  it("parseSignedMessage returns null for legacy or malformed plaintexts", () => {
    expect(parseSignedMessage("plain legacy text")).toBeNull();
    expect(parseSignedMessage('{"t":"msg","v":1,"text":"no signature"}')).toBeNull();
    expect(parseSignedMessage("{not json")).toBeNull();
    expect(parseSignedMessage('{"t":"room_name","v":1,"name":"x"}')).toBeNull();
    expect(parseSignedMessage(
      JSON.stringify({ t: "msg", v: 1, text: "x", nick: "a", pk: "A".repeat(42), sig: "AAAA" }),
    )).toBeNull(); // pk not 43 chars
  });

  it("parseSignedMessage rejects invalid nick claims", () => {
    const inner = JSON.stringify({
      t: "msg", v: 1, text: "x", nick: "way too long nick for the limit!!", pk: "A".repeat(43), sig: "B".repeat(86),
    });
    expect(parseSignedMessage(inner)).toBeNull();
    expect(isValidNick("a\nb")).toBe(false);
  });
});

describe("signed nick wrap/verify (P6)", () => {
  it("wraps and verifies a signed nick update (noop crypto returns the inner JSON)", async () => {
    const id = await makeIdentity();
    const inner = await wrapSignedNick(id, noopCrypto, CH, "alice");
    const obj = JSON.parse(inner) as { t: string; v: number; nick: string; pk: string; sig: string };
    expect(obj.t).toBe("nick");
    expect(obj.v).toBe(1);
    expect(obj.nick).toBe("alice");
    expect(obj.pk).toBe(id.pubB64);
    await expect(verifySignedNick(CH, obj.nick, obj.pk, obj.sig)).resolves.toBe(true);
  });

  it("binds the nick signature to the room", async () => {
    const id = await makeIdentity();
    const inner = await wrapSignedNick(id, noopCrypto, CH, "alice");
    const obj = JSON.parse(inner) as { nick: string; pk: string; sig: string };
    await expect(verifySignedNick("other-room", obj.nick, obj.pk, obj.sig)).resolves.toBe(false);
  });

  it("rejects invalid nicks", async () => {
    const id = await makeIdentity();
    await expect(wrapSignedNick(id, noopCrypto, CH, "  ")).rejects.toThrow(/invalid nick/);
    await expect(wrapSignedNick(id, noopCrypto, CH, "a\nb")).rejects.toThrow(/invalid nick/);
  });

  it("nickSigData is versioned and room-bound", () => {
    expect(nickSigData(CH, "alice")).toBe(`identity-v1|nick|${CH}|alice`);
  });

  it("returns an encrypted envelope, never plaintext (regression: nick leak)", async () => {
    const id = await makeIdentity();
    const crypto = createAesGcmCrypto(await generateRoomKey(), CH);
    const wrapped = await wrapSignedNick(id, crypto, CH, "alice");
    // the payload on the wire must be a valid E2EE envelope, not raw JSON
    expect(isValidEnvelope(wrapped)).toBe(true);
    expect(wrapped.startsWith("{")).toBe(false);
    const plain = await crypto.decrypt(wrapped);
    expect((JSON.parse(plain) as { t: string }).t).toBe("nick");
  });
});
