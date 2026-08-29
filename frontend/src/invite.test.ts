import { describe, expect, it } from "vitest";
import { parseInvite, parseKeyFromHash } from "./invite.ts";

describe("parseInvite", () => {
  it("parses full invite link with key", () => {
    const inv = parseInvite("http://x.test/r/abc123#k=K43charactersbase64urlkey0000000000");
    expect(inv.id).toBe("abc123");
    expect(inv.key).toBe("K43charactersbase64urlkey0000000000");
  });

  it("parses invite link without key", () => {
    const inv = parseInvite("https://x.test/r/abc123");
    expect(inv.id).toBe("abc123");
    expect(inv.key).toBeNull();
  });

  it("parses bare room id", () => {
    const inv = parseInvite("abc123");
    expect(inv.id).toBe("abc123");
    expect(inv.key).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(parseInvite("  /r/abc123#k=k  ").id).toBe("abc123");
    expect(parseInvite("  /r/abc123#k=k  ").key).toBe("k");
  });

  it("decodes percent-encoded key", () => {
    expect(parseInvite("/r/abc123#k=a%20b").key).toBe("a b");
  });

  it("keeps raw value on malformed %-encoding instead of throwing", () => {
    const inv = parseInvite("/r/abc123#k=%zz");
    expect(inv.id).toBe("abc123");
    expect(inv.key).toBe("%zz");
  });
});

describe("parseKeyFromHash", () => {
  it("returns null for empty or keyless hash", () => {
    expect(parseKeyFromHash("")).toBeNull();
    expect(parseKeyFromHash("#")).toBeNull();
    expect(parseKeyFromHash("#foo=1")).toBeNull();
  });

  it("parses #k= value", () => {
    expect(parseKeyFromHash("#k=abc")).toBe("abc");
  });

  it("parses k= among other hash params", () => {
    expect(parseKeyFromHash("#a=1&k=abc")).toBe("abc");
  });

  it("supports legacy #key= param", () => {
    expect(parseKeyFromHash("#key=abc")).toBe("abc");
  });

  it("stops at the next & and decodes", () => {
    expect(parseKeyFromHash("#k=a%2Fb&extra=1")).toBe("a/b");
  });

  it("keeps raw value on malformed %-encoding instead of throwing", () => {
    expect(parseKeyFromHash("#k=%zz")).toBe("%zz");
  });
});
