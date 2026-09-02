// test-helpers/mockws.ts — minimal WebSocket mock shared by transport/channel tests

export class MockWS {
  static instances: MockWS[] = [];
  url: string;
  readyState = 0; // CONNECTING
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockWS.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3; // CLOSED
    this.closed = true;
    this.onclose?.(new CloseEvent("close"));
  }
  // helpers to simulate server-side events
  simulateOpen() {
    this.readyState = 1; // OPEN
    this.onopen?.(new Event("open"));
  }
  simulateMessage(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

/** Replace globalThis.WebSocket with MockWS; returns a restore function. */
export function installMockWS(): () => void {
  const origWS = globalThis.WebSocket as unknown as typeof WebSocket;
  (globalThis as unknown as Record<string, unknown>).WebSocket = MockWS;
  (globalThis.WebSocket as unknown as Record<string, number>).CONNECTING = 0;
  (globalThis.WebSocket as unknown as Record<string, number>).OPEN = 1;
  (globalThis.WebSocket as unknown as Record<string, number>).CLOSED = 3;
  MockWS.instances = [];
  return () => {
    (globalThis as unknown as Record<string, unknown>).WebSocket = origWS;
  };
}
