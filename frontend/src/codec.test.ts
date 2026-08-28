import { describe, it, expect } from "vitest";
import { encode, decode, isClientMessage, isServerMessage } from "./codec.ts";
import fs from "fs";
import path from "path";

describe("codec", () => {
  it("round-trips examples", () => {
    const dir = path.resolve("../protocol/examples");
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const raw = fs.readFileSync(path.join(dir, f), "utf-8");
      const msg = decode(raw);
      const encoded = encode(msg);
      const reparsed = decode(encoded);
      expect(reparsed).toEqual(msg);
    }
  });

  it("rejects unknown type", () => {
    expect(() => decode(`{"type":"unknown"}`)).toThrow();
  });

  it("rejects invalid channelId", () => {
    expect(() => decode(`{"type":"join_channel","channelId":"bad!"}`)).toThrow();
    expect(() => encode({ type: "join_channel", channelId: "bad!" } as never)).toThrow();
  });

  it("rejects payload too large", () => {
    const big = "a".repeat(9000);
    expect(() => encode({ type: "send_message", channelId: "valid123", payload: big } as never)).toThrow();
  });

  it("distinguishes client/server messages", () => {
    expect(isClientMessage({ type: "create_channel" } as never)).toBe(true);
    expect(isClientMessage({ type: "message", channelId: "a", payload: "x", from: "p" } as never)).toBe(false);
    expect(isServerMessage({ type: "message", channelId: "a", payload: "x", from: "p" } as never)).toBe(true);
    expect(isServerMessage({ type: "create_channel" } as never)).toBe(false);
  });

  it("encodes and decodes all message types", () => {
    const msgs = [
      { type: "create_channel" },
      { type: "join_channel", channelId: "abc123" },
      { type: "leave_channel", channelId: "abc123" },
      { type: "send_message", channelId: "abc123", payload: "hello" },
      { type: "channel_created", channelId: "abc123" },
      { type: "joined", channelId: "abc123", online: 2 },
      { type: "left", channelId: "abc123" },
      { type: "message", channelId: "abc123", payload: "hi", from: "peer-1" },
      { type: "online_count", channelId: "abc123", count: 3 },
      { type: "error", code: "invalid_message", message: "bad" },
    ] as never[];
    for (const m of msgs) {
      const raw = encode(m);
      const decoded = decode(raw);
      expect(decoded).toEqual(m);
    }
  });
});
