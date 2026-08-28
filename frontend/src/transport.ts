// transport.ts — WebSocket lifecycle only
// Responsibilities: connect/disconnect/sendRaw/onRawMessage
// Does NOT parse protocol, does NOT handle E2EE, does NOT touch UI state.

export type RawMessageHandler = (data: string) => void;
export type StatusHandler = (status: TransportStatus) => void;
export type TransportStatus = "idle" | "connecting" | "open" | "closed" | "error";

export class Transport {
  private url: string;
  private ws: WebSocket | null = null;
  private status: TransportStatus = "idle";
  private messageHandlers = new Set<RawMessageHandler>();
  private statusHandlers = new Set<StatusHandler>();

  constructor(url: string) {
    this.url = url;
  }

  getStatus(): TransportStatus {
    return this.status;
  }

  onRawMessage(handler: RawMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    // immediately notify current status
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  private setStatus(s: TransportStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const h of this.statusHandlers) {
      try {
        h(s);
      } catch {
        // ignore handler errors
      }
    }
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.setStatus("open");
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      const data = typeof ev.data === "string" ? ev.data : "";
      if (!data) return;
      for (const h of this.messageHandlers) {
        try {
          h(data);
        } catch {
          // ignore
        }
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.setStatus("error");
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus("closed");
    };
  }

  disconnect(code = 1000, reason = ""): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(code, reason);
      } catch {
        // ignore
      }
    }
    this.setStatus("closed");
  }

  sendRaw(data: string): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      ws.send(data);
      return true;
    } catch {
      return false;
    }
  }
}
