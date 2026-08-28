// transport.ts — WebSocket lifecycle only
// Responsibilities: connect/disconnect/sendRaw/onRawMessage + auto-reconnect + send queue
// Does NOT parse protocol, does NOT handle E2EE, does NOT touch UI state.

export type RawMessageHandler = (data: string) => void;
export type StatusHandler = (status: TransportStatus) => void;
export type TransportStatus = "idle" | "connecting" | "open" | "closed" | "error" | "reconnecting";

export type TransportOptions = {
  autoReconnect?: boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export class Transport {
  private url: string;
  private ws: WebSocket | null = null;
  private status: TransportStatus = "idle";
  private messageHandlers = new Set<RawMessageHandler>();
  private statusHandlers = new Set<StatusHandler>();

  // reconnect
  private autoReconnect: boolean;
  private baseDelayMs: number;
  private maxDelayMs: number;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;
  private sendQueue: string[] = [];

  constructor(url: string, opts: TransportOptions = {}) {
    this.url = url;
    this.autoReconnect = opts.autoReconnect ?? true;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.maxDelayMs = opts.maxDelayMs ?? 10000;
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
        // ignore
      }
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnect || !this.shouldReconnect) return;
    this.clearReconnectTimer();
    const exp = Math.min(this.baseDelayMs * Math.pow(2, this.reconnectAttempt), this.maxDelayMs);
    const jitter = 0.8 + Math.random() * 0.4; // 0.8 - 1.2
    const delay = exp * jitter;
    this.reconnectAttempt += 1;
    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private flushQueue(): void {
    if (this.sendQueue.length === 0) return;
    const q = [...this.sendQueue];
    this.sendQueue = [];
    for (const data of q) {
      this.sendRaw(data);
    }
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }
    this.shouldReconnect = true;
    this.clearReconnectTimer();
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectAttempt = 0;
      this.setStatus("open");
      this.flushQueue();
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
      this.scheduleReconnect();
    };
  }

  disconnect(code = 1000, reason = ""): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.sendQueue = [];
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
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(data);
        return true;
      } catch {
        return false;
      }
    }
    // queue if we intend to reconnect
    if (this.autoReconnect && this.shouldReconnect) {
      // simple cap to avoid unbounded growth (P1: 100)
      if (this.sendQueue.length < 100) {
        this.sendQueue.push(data);
      }
      return true; // queued
    }
    return false;
  }
}
