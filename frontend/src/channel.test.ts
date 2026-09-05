import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelStore, createChannel } from "./channel.svelte.ts";
import { MockWS, installMockWS } from "./test-helpers/mockws.ts";
import {
  createAesGcmCrypto,
  exportRoomKey,
  generateRoomKey,
  importRoomKey,
  importRoomKeyRaw,
  newMessageIdB64,
  wrapNewKey,
  wrapNick,
  wrapRoomName,
  type Crypto,
} from "./e2ee.ts";
import { generateIdentity, wrapSignedMessage, wrapSignedNick, type Identity } from "./identity.ts";

// flush pending async work (decrypt/unwrap chains span several task turns)
const tick = () => new Promise<void>((r) => setTimeout(r, 25));

const CH = "room-test-1";

function msgFrame(channelId: string, payload: string): string {
  return JSON.stringify({ type: "message", channelId, payload, from: "peer-abcd1234", self: false });
}

function updatedFrame(kind: "key_updated" | "room_name_updated" | "nickname_updated", channelId: string, payload: string, from: string, self = false): string {
  return JSON.stringify({ type: kind, channelId, payload, from, self });
}

async function makeCrypto(channelId = CH): Promise<Crypto> {
  return createAesGcmCrypto(await generateRoomKey(), channelId);
}

/** Connect a store, simulate server accept, and assert the automatic join frame. */
async function openStore(channelId: string, crypto: Crypto, opts = {}) {
  const store = new ChannelStore(channelId, crypto, opts);
  store.connect();
  const ws = MockWS.instances[0];
  ws.simulateOpen();
  expect(JSON.parse(ws.sent[0])).toEqual({ type: "join_channel", channelId });
  return { store, ws };
}

describe("createChannel helper", () => {
  let restoreWS: () => void;
  beforeEach(() => {
    restoreWS = installMockWS();
  });
  afterEach(() => {
    restoreWS();
  });

  it("sends create_channel on open and resolves with channelId", async () => {
    const p = createChannel();
    const ws = MockWS.instances[0];
    ws.simulateOpen();
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "create_channel" });
    ws.simulateMessage(JSON.stringify({ type: "channel_created", channelId: "abc12345" }));
    await expect(p).resolves.toBe("abc12345");
    expect(ws.closed).toBe(true);
  });

  it("rejects on error response", async () => {
    const p = createChannel();
    const ws = MockWS.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: "error", code: "rate_limited", message: "too many requests" }));
    await expect(p).rejects.toThrow(/rate_limited: too many requests/);
    expect(ws.closed).toBe(true);
  });
});

describe("ChannelStore", () => {
  let restoreWS: () => void;
  beforeEach(() => {
    restoreWS = installMockWS();
  });
  afterEach(() => {
    restoreWS();
  });

  it("decrypts and appends valid messages", async () => {
    const crypto = await makeCrypto();
    const { store, ws } = await openStore(CH, crypto);
    ws.simulateMessage(msgFrame(CH, await crypto.encrypt("hi there")));
    await tick();
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].payload).toBe("hi there");
    expect(typeof store.messages[0].ts).toBe("number");
    expect(store.error).toBeNull();
    store.disconnect();
  });

  it("drops replayed envelopes", async () => {
    const crypto = await makeCrypto();
    const { store, ws } = await openStore(CH, crypto);
    const payload = await crypto.encrypt("once");
    ws.simulateMessage(msgFrame(CH, payload));
    await tick();
    ws.simulateMessage(msgFrame(CH, payload)); // same envelope => same messageId
    await tick();
    expect(store.messages).toHaveLength(1);
    expect(store.error).toBe("replay dropped");
    store.disconnect();
  });

  it("appends placeholder for invalid envelopes", async () => {
    const crypto = await makeCrypto();
    const { store, ws } = await openStore(CH, crypto);
    ws.simulateMessage(msgFrame(CH, "garbage"));
    await tick();
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].payload).toBe("⚠️ invalid envelope");
    expect(store.error).toBe("invalid envelope");
    store.disconnect();
  });

  it("appends decrypt-failed placeholder for wrong key", async () => {
    const crypto = await makeCrypto();
    const other = await makeCrypto();
    const { store, ws } = await openStore(CH, crypto);
    ws.simulateMessage(msgFrame(CH, await other.encrypt("for someone else")));
    await tick();
    expect(store.messages[0].payload).toBe("⚠️ decrypt failed");
    expect(store.error).toContain("decrypt failed");
    store.disconnect();
  });

  it("rotates crypto on key_updated and decrypts with the new key", async () => {
    const oldKey = await importRoomKeyRaw(crypto.getRandomValues(new Uint8Array(32)));
    const oldCrypto = createAesGcmCrypto(oldKey, CH);
    const onKeyRotated = vi.fn();
    const { store, ws } = await openStore(CH, oldCrypto, { onKeyRotated });

    const newKeyB64 = await exportRoomKey(await generateRoomKey());
    const wrapped = await wrapNewKey(oldCrypto, newKeyB64);
    ws.simulateMessage(updatedFrame("key_updated", CH, wrapped, "peer-rot"));
    await tick();

    expect(onKeyRotated).toHaveBeenCalledTimes(1);
    expect(onKeyRotated.mock.calls[0][0]).toBe(newKeyB64);
    const rotMsg = store.messages.find((m) => m.sys?.sysKind === "key_rotation");
    expect(rotMsg?.sys?.actor).toBe("peer-rot");
    expect(store.error).toBeNull();

    // the store now decrypts envelopes sealed with the new key
    const newCrypto = createAesGcmCrypto(await importRoomKey(newKeyB64), CH);
    ws.simulateMessage(msgFrame(CH, await newCrypto.encrypt("after rotation")));
    await tick();
    expect(store.messages[store.messages.length - 1].payload).toBe("after rotation");

    // replaying the same rotation envelope is dropped
    const before = store.messages.length;
    ws.simulateMessage(updatedFrame("key_updated", CH, wrapped, "peer-rot"));
    await tick();
    expect(store.messages).toHaveLength(before);
    expect(store.error).toBe("replay dropped (key_update)");
    store.disconnect();
  });

  it("keeps old crypto when key_updated cannot be decrypted", async () => {
    const oldCrypto = await makeCrypto();
    const stranger = await makeCrypto();
    const { store, ws } = await openStore(CH, oldCrypto);

    const wrapped = await wrapNewKey(stranger, await exportRoomKey(await generateRoomKey()));
    ws.simulateMessage(updatedFrame("key_updated", CH, wrapped, "peer-x"));
    await tick();
    expect(store.error).toBe("key rotation failed (decrypt/import)");

    // old key still works
    ws.simulateMessage(msgFrame(CH, await oldCrypto.encrypt("still old key")));
    await tick();
    expect(store.messages[store.messages.length - 1].payload).toBe("still old key");
    store.disconnect();
  });

  it("ignores own key_updated echo (rotator already switched locally)", async () => {
    const oldCrypto = await makeCrypto();
    const { store, ws } = await openStore(CH, oldCrypto);

    const newKeyB64 = await exportRoomKey(await generateRoomKey());
    const newCrypto = createAesGcmCrypto(await importRoomKey(newKeyB64), CH);
    store.updateCrypto(newCrypto); // what rotateKeyViaE2EE does before the echo arrives
    const wrapped = await wrapNewKey(oldCrypto, newKeyB64); // sealed with the OLD key
    ws.simulateMessage(updatedFrame("key_updated", CH, wrapped, "peer-self", true));
    await tick();
    expect(store.error).toBeNull();
    expect(store.messages.filter((m) => m.sys?.sysKind === "key_rotation")).toHaveLength(0);

    // the (already active) new key keeps working for normal traffic
    ws.simulateMessage(msgFrame(CH, await newCrypto.encrypt("still fine")));
    await tick();
    expect(store.messages[store.messages.length - 1].payload).toBe("still fine");
    store.disconnect();
  });

  it("handles room_name_updated: callback + system message, dedup on same name", async () => {
    const crypto = await makeCrypto();
    const onRoomNameUpdated = vi.fn();
    const { store, ws } = await openStore(CH, crypto, { onRoomNameUpdated });

    ws.simulateMessage(updatedFrame("room_name_updated", CH, await wrapRoomName(crypto, "My Room"), "peer-namer"));
    await tick();
    expect(onRoomNameUpdated).toHaveBeenCalledWith("My Room", "peer-namer");
    const sysMsg = store.messages.find((m) => m.sys?.sysKind === "room_name");
    expect(sysMsg?.payload).toBe("My Room");
    expect(sysMsg?.sys?.actor).toBe("peer-namer");

    // a different envelope carrying the same name: callback fires, no duplicate system message
    ws.simulateMessage(updatedFrame("room_name_updated", CH, await wrapRoomName(crypto, "My Room"), "peer-namer"));
    await tick();
    expect(onRoomNameUpdated).toHaveBeenCalledTimes(2);
    expect(store.messages.filter((m) => m.sys?.sysKind === "room_name")).toHaveLength(1);

    // envelope from a stranger (wrong key): error, no callback
    const stranger = await makeCrypto();
    ws.simulateMessage(updatedFrame("room_name_updated", CH, await wrapRoomName(stranger, "Evil"), "peer-evil"));
    await tick();
    expect(onRoomNameUpdated).toHaveBeenCalledTimes(2);
    expect(store.error).toBe("room_name update failed");
    store.disconnect();
  });

  it("applies initial (re-announcement) room name silently", async () => {
    const crypto = await makeCrypto();
    const onRoomNameUpdated = vi.fn();
    const { store, ws } = await openStore(CH, crypto, { onRoomNameUpdated });

    // peer-join sync frame: name must be applied without a timeline entry
    ws.simulateMessage(updatedFrame("room_name_updated", CH, await wrapRoomName(crypto, "Synced Name", { initial: true }), "peer-namer"));
    await tick();
    expect(onRoomNameUpdated).toHaveBeenCalledWith("Synced Name", "peer-namer");
    expect(store.messages).toHaveLength(0);
    expect(store.error).toBeNull();

    // a later genuine rename still produces the system message
    ws.simulateMessage(updatedFrame("room_name_updated", CH, await wrapRoomName(crypto, "Renamed"), "peer-namer"));
    await tick();
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].payload).toBe("Renamed");
    store.disconnect();
  });

  it("handles nickname_updated callback without touching the timeline", async () => {
    const crypto = await makeCrypto();
    const onNicknameUpdated = vi.fn();
    const { store, ws } = await openStore(CH, crypto, { onNicknameUpdated });

    ws.simulateMessage(updatedFrame("nickname_updated", CH, await wrapNick(crypto, "alice"), "peer-n1"));
    await tick();
    expect(onNicknameUpdated).toHaveBeenCalledWith("peer-n1", "alice");
    expect(store.error).toBeNull();
    expect(store.messages).toHaveLength(0);

    const stranger = await makeCrypto();
    ws.simulateMessage(updatedFrame("nickname_updated", CH, await wrapNick(stranger, "mallory"), "peer-n2"));
    await tick();
    expect(onNicknameUpdated).toHaveBeenCalledTimes(1);
    expect(store.error).toBe("nickname update failed");
    store.disconnect();
  });

  it("updates online/status/error state from server frames", async () => {
    const crypto = await makeCrypto();
    const { store, ws } = await openStore(CH, crypto);
    expect(store.status).toBe("open");

    ws.simulateMessage(JSON.stringify({ type: "joined", channelId: CH, online: 1 }));
    await tick();
    expect(store.online).toBe(1);

    ws.simulateMessage(JSON.stringify({ type: "online_count", channelId: CH, count: 3 }));
    await tick();
    expect(store.online).toBe(3);

    ws.simulateMessage(JSON.stringify({ type: "error", code: "rate_limited", message: "slow down" }));
    await tick();
    expect(store.error).toBe("rate_limited: slow down");

    store.disconnect();
    expect(store.status).toBe("closed");
  });

  it("sendMessage encrypts plaintext before sending", async () => {
    const crypto = await makeCrypto();
    const { store, ws } = await openStore(CH, crypto);
    const ok = await store.sendMessage("secret text");
    expect(ok).toBe(true);
    const frame = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(frame.type).toBe("send_message");
    expect(frame.channelId).toBe(CH);
    expect(frame.payload).not.toBe("secret text");
    expect(frame.payload.split(".")).toHaveLength(3);
    // the sender can still decrypt its own envelope (echo path)
    expect(await crypto.decrypt(frame.payload)).toBe("secret text");
    store.disconnect();
  });

  it("sendMessage rejects blank text", async () => {
    const crypto = await makeCrypto();
    const { store, ws } = await openStore(CH, crypto);
    const sentBefore = ws.sent.length;
    expect(await store.sendMessage("   ")).toBe(false);
    expect(ws.sent).toHaveLength(sentBefore);
    store.disconnect();
  });

  it("disconnect sends leave_channel and closes the transport", async () => {
    const crypto = await makeCrypto();
    const { store, ws } = await openStore(CH, crypto);
    store.disconnect();
    expect(JSON.parse(ws.sent[ws.sent.length - 1])).toEqual({ type: "leave_channel", channelId: CH });
    expect(ws.closed).toBe(true);
    expect(await store.sendMessage("after close")).toBe(false);
    expect(store.error).toBeTruthy();
  });

  it("two stores operate independently (multi-room)", async () => {    const cryptoA = createAesGcmCrypto(await importRoomKeyRaw(crypto.getRandomValues(new Uint8Array(32))), "room-a");
    const cryptoB = createAesGcmCrypto(await importRoomKeyRaw(crypto.getRandomValues(new Uint8Array(32))), "room-b");
    const sA = new ChannelStore("room-a", cryptoA);
    const sB = new ChannelStore("room-b", cryptoB);
    sA.connect();
    sB.connect();
    const wsA = MockWS.instances[0];
    const wsB = MockWS.instances[1];
    wsA.simulateOpen();
    wsB.simulateOpen();
    // each store joins its own room
    expect(JSON.parse(wsA.sent[0]).channelId).toBe("room-a");
    expect(JSON.parse(wsB.sent[0]).channelId).toBe("room-b");
    // traffic for B does not touch A
    wsB.simulateMessage(msgFrame("room-b", await cryptoB.encrypt("for b only")));
    await tick();
    expect(sB.messages).toHaveLength(1);
    expect(sB.messages[0].payload).toBe("for b only");
    expect(sA.messages).toHaveLength(0);
    expect(sA.error).toBeNull();
    // key rotation in A leaves B's crypto alone
    const newKeyA = await exportRoomKey(await generateRoomKey());
    wsA.simulateMessage(updatedFrame("key_updated", "room-a", await wrapNewKey(cryptoA, newKeyA), "peer-a"));
    await tick();
    expect(sA.error).toBeNull();
    expect(sB.error).toBeNull();
    // outbound frames carry their own channelId
    expect(await sA.sendMessage("from a")).toBe(true);
    expect(await sB.sendMessage("from b")).toBe(true);
    const frameA = JSON.parse(wsA.sent[wsA.sent.length - 1]);
    const frameB = JSON.parse(wsB.sent[wsB.sent.length - 1]);
    expect(frameA.channelId).toBe("room-a");
    expect(frameB.channelId).toBe("room-b");
    sA.disconnect();
    sB.disconnect();
  });
});

describe("identity: signed messages (P6)", () => {
  let restoreWS: () => void;
  beforeEach(() => {
    restoreWS = installMockWS();
  });
  afterEach(() => {
    restoreWS();
  });

  /** Simulate a server message frame whose inner plaintext is signed by a peer identity. */
  async function peerSignedFrame(
    crypto: Crypto,
    peer: Identity,
    text: string,
    nick: string,
    mid = newMessageIdB64(),
  ): Promise<string> {
    const inner = await wrapSignedMessage(peer, CH, mid, text, nick);
    return msgFrame(CH, await crypto.encrypt(inner, { messageIdB64: mid }));
  }

  it("sendMessage signs the inner payload and binds the envelope messageId", async () => {
    const crypto = await makeCrypto();
    const identity = await generateIdentity();
    const { store, ws } = await openStore(CH, crypto);
    store.setIdentity(identity, () => "self-nick");
    await store.sendMessage("signed hello");
    const frame = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(frame.type).toBe("send_message");
    const inner = JSON.parse(await crypto.decrypt(frame.payload)) as {
      t: string; v: number; text: string; nick: string; pk: string; sig: string;
    };
    expect(inner.t).toBe("msg");
    expect(inner.v).toBe(1);
    expect(inner.text).toBe("signed hello");
    expect(inner.nick).toBe("self-nick");
    expect(inner.pk).toBe(identity.pubB64);
    // the envelope carries exactly the pre-set messageId the signature covers
    expect(frame.payload.split(".")[1]).toBeTruthy();
    store.disconnect();
  });

  it("sendMessage falls back to the unsigned legacy path without identity", async () => {
    const crypto = await makeCrypto();
    const { store, ws } = await openStore(CH, crypto);
    await store.sendMessage("legacy hello");
    const frame = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(await crypto.decrypt(frame.payload)).toBe("legacy hello");
    store.disconnect();
  });

  it("verifies an incoming signed message and attaches ident", async () => {
    const crypto = await makeCrypto();
    const peer = await generateIdentity();
    const { store, ws } = await openStore(CH, crypto);
    ws.simulateMessage(await peerSignedFrame(crypto, peer, "from peer", "alice"));
    await tick();
    expect(store.messages).toHaveLength(1);
    const m = store.messages[0];
    expect(m.payload).toBe("from peer");
    expect(m.ident?.status).toBe("verified");
    expect(m.ident?.fp).toBe(peer.fp);
    expect(m.ident?.nick).toBe("alice");
    expect(m.ident?.pk).toBe(peer.pubB64);
    expect(store.error).toBeNull();
    store.disconnect();
  });

  it("shows a placeholder and hides content when the signature is invalid", async () => {
    const crypto = await makeCrypto();
    const peer = await generateIdentity();
    const { store, ws } = await openStore(CH, crypto);
    // sign one text, then swap the text after signing (forgery attempt)
    const mid = newMessageIdB64();
    const inner = await wrapSignedMessage(peer, CH, mid, "honest", "alice");
    const forged = JSON.stringify({ ...JSON.parse(inner), text: "evil" });
    ws.simulateMessage(msgFrame(CH, await crypto.encrypt(forged, { messageIdB64: mid })));
    await tick();
    const m = store.messages[0];
    expect(m.payload).toBe("⚠️ invalid signature");
    expect(m.ident?.status).toBe("invalid");
    expect(store.error).toBe("invalid signature");
    store.disconnect();
  });

  it("renders legacy unsigned plaintexts without ident", async () => {
    const crypto = await makeCrypto();
    const { store, ws } = await openStore(CH, crypto);
    ws.simulateMessage(msgFrame(CH, await crypto.encrypt("old client here")));
    await tick();
    expect(store.messages[0].payload).toBe("old client here");
    expect(store.messages[0].ident).toBeUndefined();
    store.disconnect();
  });

  it("flags a nick conflict when a second identity claims the same nick", async () => {
    const crypto = await makeCrypto();
    const alice = await generateIdentity();
    const mallory = await generateIdentity();
    const { store, ws } = await openStore(CH, crypto);
    ws.simulateMessage(await peerSignedFrame(crypto, alice, "hi", "alice"));
    await tick();
    expect(store.messages[0].ident?.status).toBe("verified");
    ws.simulateMessage(await peerSignedFrame(crypto, mallory, "me too", "alice"));
    await tick();
    expect(store.messages[1].ident?.status).toBe("conflict");
    // the original claimant stays verified
    ws.simulateMessage(await peerSignedFrame(crypto, alice, "still me", "alice"));
    await tick();
    expect(store.messages[2].ident?.status).toBe("verified");
    store.disconnect();
  });

  it("verifies the sender's own echo with the session identity", async () => {
    const crypto = await makeCrypto();
    const identity = await generateIdentity();
    const { store, ws } = await openStore(CH, crypto);
    store.setIdentity(identity, () => "self-nick");
    await store.sendMessage("echo me");
    const frame = JSON.parse(ws.sent[ws.sent.length - 1]);
    ws.simulateMessage(
      JSON.stringify({ type: "message", channelId: CH, payload: frame.payload, from: "peer-self", self: true }),
    );
    await tick();
    const m = store.messages.find((x) => x.self === true);
    expect(m?.ident?.status).toBe("verified");
    expect(m?.payload).toBe("echo me");
    store.disconnect();
  });

  it("handles signed nickname updates; drops forged ones", async () => {
    const crypto = await makeCrypto();
    const peer = await generateIdentity();
    const onNicknameUpdated = vi.fn();
    const { store, ws } = await openStore(CH, crypto, { onNicknameUpdated });

    const good = await wrapSignedNick(peer, CH, "carol");
    ws.simulateMessage(updatedFrame("nickname_updated", CH, await crypto.encrypt(good), "peer-n1"));
    await tick();
    expect(onNicknameUpdated).toHaveBeenCalledWith("peer-n1", "carol");
    expect(store.error).toBeNull();

    // signed by a real key but the nick was swapped after signing -> forgery dropped
    const evil = await generateIdentity();
    const inner = JSON.parse(await wrapSignedNick(evil, CH, "mallory")) as Record<string, unknown>;
    inner.nick = "carol"; // signature was computed over "mallory"
    ws.simulateMessage(updatedFrame("nickname_updated", CH, await crypto.encrypt(JSON.stringify(inner)), "peer-n2"));
    await tick();
    expect(onNicknameUpdated).toHaveBeenCalledTimes(1);
    expect(store.error).toBe("invalid signature (nick)");
    store.disconnect();
  });

  it("keeps the unsigned nickname path for legacy clients", async () => {
    const crypto = await makeCrypto();
    const onNicknameUpdated = vi.fn();
    const { store, ws } = await openStore(CH, crypto, { onNicknameUpdated });
    ws.simulateMessage(updatedFrame("nickname_updated", CH, await wrapNick(crypto, "oldnick"), "peer-old"));
    await tick();
    expect(onNicknameUpdated).toHaveBeenCalledWith("peer-old", "oldnick");
    expect(store.error).toBeNull();
    store.disconnect();
  });
});
