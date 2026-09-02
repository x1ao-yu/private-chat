import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Transport } from "./transport.ts";
import { MockWS, installMockWS } from "./test-helpers/mockws.ts";

describe("Transport", () => {
  let restoreWS: () => void;

  beforeEach(() => {
    restoreWS = installMockWS();
  });

  afterEach(() => {
    restoreWS();
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

  it("reconnects with exponential backoff up to 10s with jitter", () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter 1.0 (0.8+0.2)
    const t = new Transport("ws://example/ws", { baseDelayMs: 1000, maxDelayMs: 10000 });
    t.connect();
    expect(MockWS.instances).toHaveLength(1);
    MockWS.instances[0].simulateOpen();
    expect(t.getStatus()).toBe("open");

    // simulate remote close (not via disconnect)
    const ws1 = MockWS.instances[0];
    ws1.readyState = 3;
    ws1.onclose?.(new CloseEvent("close"));
    expect(t.getStatus()).toBe("reconnecting");

    // first reconnect after ~1000ms
    vi.advanceTimersByTime(1000);
    expect(MockWS.instances).toHaveLength(2);
    expect(t.getStatus()).toBe("connecting");

    // open second connection
    MockWS.instances[1].simulateOpen();
    expect(t.getStatus()).toBe("open");

    // close again, second backoff 2000ms
    MockWS.instances[1].readyState = 3;
    MockWS.instances[1].onclose?.(new CloseEvent("close"));
    vi.advanceTimersByTime(2000);
    expect(MockWS.instances).toHaveLength(3);

    // test cap at 10000: need 4 more attempts 4000,8000,10000,10000...
    for (let i = 0; i < 2; i++) {
      const last = MockWS.instances[MockWS.instances.length - 1];
      last.simulateOpen();
      last.readyState = 3;
      last.onclose?.(new CloseEvent("close"));
      const expected = [4000, 8000][i];
      vi.advanceTimersByTime(expected);
    }
    expect(MockWS.instances).toHaveLength(5);
    // next should be capped at 10000
    MockWS.instances[4].simulateOpen();
    MockWS.instances[4].readyState = 3;
    MockWS.instances[4].onclose?.(new CloseEvent("close"));
    vi.advanceTimersByTime(10000);
    expect(MockWS.instances).toHaveLength(6);

    t.disconnect();
    randomSpy.mockRestore();
    vi.useRealTimers();
  });

  it("queues messages while reconnecting and flushes on open", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const t = new Transport("ws://example/ws", { baseDelayMs: 1000, maxDelayMs: 10000 });
    t.connect();
    MockWS.instances[0].simulateOpen();
    expect(t.sendRaw("a")).toBe(true);
    expect(MockWS.instances[0].sent).toEqual(["a"]);

    // remote close
    MockWS.instances[0].readyState = 3;
    MockWS.instances[0].onclose?.(new CloseEvent("close"));
    expect(t.getStatus()).toBe("reconnecting");
    // send while reconnecting should queue and return true
    expect(t.sendRaw("queued1")).toBe(true);
    expect(t.sendRaw("queued2")).toBe(true);
    expect(MockWS.instances[0].sent).toEqual(["a"]); // not sent yet

    vi.advanceTimersByTime(1000);
    const ws2 = MockWS.instances[1];
    ws2.simulateOpen();
    // flushed
    expect(ws2.sent).toEqual(["queued1", "queued2"]);

    t.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not reconnect after explicit disconnect", () => {
    vi.useFakeTimers();
    const t = new Transport("ws://example/ws", { baseDelayMs: 1000 });
    t.connect();
    MockWS.instances[0].simulateOpen();
    t.disconnect();
    expect(t.getStatus()).toBe("closed");
    // even if underlying ws fires close again, should not reconnect
    MockWS.instances[0].readyState = 3;
    MockWS.instances[0].onclose?.(new CloseEvent("close"));
    vi.advanceTimersByTime(5000);
    expect(MockWS.instances).toHaveLength(1);
    vi.useRealTimers();
  });
});
