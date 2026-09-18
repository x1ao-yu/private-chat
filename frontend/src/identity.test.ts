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
  staleSignedMessagePk,
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

  it("keeps the private key non-extractable while the public key stays exportable", async () => {
    const id = await makeIdentity();
    // hardening: the private key must reject any export attempt
    await expect(crypto.subtle.exportKey("pkcs8", id.privateKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("jwk", id.privateKey)).rejects.toThrow();
    // the public key is still exportable (32-byte raw, travels in the payload)
    const rawPub = await crypto.subtle.exportKey("raw", id.publicKey);
    expect(new Uint8Array(rawPub).length).toBe(32);
    // the re-imported key still signs
    const sig = await signIdentity(id.privateKey, "hello");
    await expect(verifyIdentity(id.pubB64, sig, "hello")).resolves.toBe(true);
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
    expect(messageSigData(CH, MID, "alice", "hi")).toBe(`identity-v2|msg|${CH}|${MID}|5:alice|2:hi`);
  });

  it("wrapSignedMessage emits an inner v2 payload", async () => {
    const id = await makeIdentity();
    const inner = await wrapSignedMessage(id, CH, MID, "hi", "alice");
    expect((JSON.parse(inner) as { v: number }).v).toBe(2);
  });

  it("parseSignedMessage returns null for legacy or malformed plaintexts", () => {
    expect(parseSignedMessage("plain legacy text")).toBeNull();
    expect(parseSignedMessage('{"t":"msg","v":1,"text":"no signature"}')).toBeNull();
    expect(parseSignedMessage("{not json")).toBeNull();
    expect(parseSignedMessage('{"t":"room_name","v":1,"name":"x"}')).toBeNull();
    expect(parseSignedMessage(
      JSON.stringify({ t: "msg", v: 2, text: "x", nick: "a", pk: "A".repeat(42), sig: "AAAA" }),
    )).toBeNull(); // pk not 43 chars
  });

  it("parseSignedMessage rejects invalid nick claims", () => {
    const inner = JSON.stringify({
      t: "msg", v: 2, text: "x", nick: "way too long nick for the limit!!", pk: "A".repeat(43), sig: "B".repeat(86),
    });
    expect(parseSignedMessage(inner)).toBeNull();
    expect(isValidNick("a\nb")).toBe(false);
  });

  it("parseSignedMessage rejects stale v1 signed claims", async () => {
    const id = await makeIdentity();
    const v2 = await wrapSignedMessage(id, CH, MID, "hi", "alice");
    const v1 = JSON.stringify({ ...JSON.parse(v2) as object, v: 1 });
    expect(parseSignedMessage(v1)).toBeNull();
  });
});

describe("stale identity-v1 detection (audit 2026-09-18)", () => {
  const pk = "A".repeat(43);
  const sig = "B".repeat(86);

  it("returns the claimed pk for a well-formed v1 signed claim", () => {
    expect(staleSignedMessagePk(JSON.stringify({ t: "msg", v: 1, text: "x", nick: "a", pk, sig }))).toBe(pk);
  });

  it("returns null for current v2 claims", async () => {
    const id = await makeIdentity();
    expect(staleSignedMessagePk(await wrapSignedMessage(id, CH, MID, "x", "a"))).toBeNull();
  });

  it("returns null for legacy text, non-JSON, other types and malformed claims", () => {
    expect(staleSignedMessagePk("plain legacy text")).toBeNull();
    expect(staleSignedMessagePk("{not json")).toBeNull();
    expect(staleSignedMessagePk('{"t":"room_name","v":1,"name":"x"}')).toBeNull();
    expect(staleSignedMessagePk(JSON.stringify({ t: "msg", v: 1, text: "x", nick: "a" }))).toBeNull(); // unsigned
    expect(staleSignedMessagePk(JSON.stringify({ t: "msg", v: 1, text: "x", nick: "a", pk, sig: "!!" }))).toBeNull();
    expect(staleSignedMessagePk(JSON.stringify({ t: "msg", v: 1, text: "x", nick: "a", pk: "short", sig }))).toBeNull();
  });
});

describe("signature canonicalization (audit 2026-09-18 regression)", () => {
  // Root cause of the audit finding: v1 joined untrusted fields with "|", so a
  // room-key holder could re-split one valid signature across the nick/text
  // boundary and still verify. These tests must fail against identity-v1.
  it("rejects a re-framed nick/text split of a valid signature", async () => {
    const id = await makeIdentity();
    const sig = await signIdentity(id.privateKey, messageSigData(CH, MID, "Alice", "meet at 9|room 3"));
    const forged = { text: "room 3", nick: "Alice|meet at 9", pk: id.pubB64, sig };
    expect(isValidNick(forged.nick)).toBe(true); // the forged nick passes field validation
    await expect(verifySignedMessage(CH, MID, forged)).resolves.toBe(false);
  });

  it("messageSigData is injective across the nick/text boundary", () => {
    expect(messageSigData(CH, MID, "Alice", "meet at 9|room 3")).not.toBe(
      messageSigData(CH, MID, "Alice|meet at 9", "room 3"),
    );
    expect(messageSigData(CH, MID, "a", "|3:bc")).not.toBe(messageSigData(CH, MID, "a|3:b", "c"));
  });

  it("length prefixes count UTF-8 bytes, not UTF-16 code units", () => {
    // thumbs-up is 2 UTF-16 units but 4 UTF-8 bytes
    expect(messageSigData(CH, MID, "\u{1F44D}", "x")).toContain("4:\u{1F44D}");
    // decomposed vs precomposed accents must not collide
    expect(messageSigData(CH, MID, "e\u0301", "x")).not.toBe(messageSigData(CH, MID, "é", "x"));
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
    expect(nickSigData(CH, "alice")).toBe(`identity-v2|nick|${CH}|5:alice`);
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
