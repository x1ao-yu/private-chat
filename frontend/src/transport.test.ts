import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Transport } from "./transport.ts";

// Minimal WebSocket mock
class MockWS {
  static instances: MockWS[] = [];
  url: string;
  readyState = 0; // CONNECTING
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    MockWS.instances.push(this);
    // @ts-ignore
    (globalThis as unknown as Record<string, unknown>).lastWS = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3; // CLOSED
    this.onclose?.(new CloseEvent("close"));
  }
  // helpers to simulate
  simulateOpen() {
    this.readyState = 1; // OPEN
    this.onopen?.(new Event("open"));
  }
  simulateMessage(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

describe("Transport", () => {
  let origWS: typeof WebSocket;

  beforeEach(() => {
    origWS = globalThis.WebSocket as unknown as typeof WebSocket;
    // @ts-ignore
    globalThis.WebSocket = MockWS as unknown as typeof WebSocket;
    // define constants
    (globalThis.WebSocket as unknown as Record<string, number>).CONNECTING = 0;
    (globalThis.WebSocket as unknown as Record<string, number>).OPEN = 1;
    (globalThis.WebSocket as unknown as Record<string, number>).CLOSED = 3;
    MockWS.instances = [];
  });

  afterEach(() => {
    globalThis.WebSocket = origWS;
  });

  it("connects and changes status", () => {
    const t = new Transport("ws://example/ws");
    const statuses: string[] = [];
    t.onStatus((s) => statuses.push(s));
    expect(t.getStatus()).toBe("idle");
    t.connect();
    expect(t.getStatus()).toBe("connecting");
    const ws = MockWS.instances[0];
    ws.simulateOpen();
    expect(t.getStatus()).toBe("open");
  });

  it("sends and receives raw messages", () => {
    const t = new Transport("ws://example/ws");
    t.connect();
    const ws = MockWS.instances[0];
    ws.simulateOpen();
    expect(t.sendRaw("hello")).toBe(true);
    expect(ws.sent).toEqual(["hello"]);

    const handler = vi.fn();
    t.onRawMessage(handler);
    ws.simulateMessage("world");
    expect(handler).toHaveBeenCalledWith("world");
  });

  it("handles disconnect", () => {
    const t = new Transport("ws://example/ws");
    t.connect();
    MockWS.instances[0].simulateOpen();
    expect(t.getStatus()).toBe("open");
    t.disconnect();
    expect(t.getStatus()).toBe("closed");
    expect(t.sendRaw("x")).toBe(false);
  });

  it("supports multiple message handlers and unsubscribe", () => {
    const t = new Transport("ws://example/ws");
    t.connect();
    const ws = MockWS.instances[0];
    ws.simulateOpen();
    const h1 = vi.fn();
    const h2 = vi.fn();
    const off1 = t.onRawMessage(h1);
    t.onRawMessage(h2);
    ws.simulateMessage("a");
    expect(h1).toHaveBeenCalledWith("a");
    expect(h2).toHaveBeenCalledWith("a");
    off1();
    ws.simulateMessage("b");
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(2);
  });
});
