// channel.svelte.ts — UI state only, composes transport + codec + e2ee
import { Transport, type TransportStatus } from "./transport.ts";
import { encode, decode, type AnyMessage } from "./codec.ts";
import { noopCrypto, type Crypto } from "./e2ee.ts";
import type { BroadcastMessage } from "./protocol.gen.ts";

function getWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

export async function createChannel(): Promise<string> {
  const transport = new Transport(getWsUrl(), { autoReconnect: false });
  return new Promise((resolve, reject) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        offMsg();
        offStatus();
        transport.disconnect();
        reject(new Error("timeout creating channel"));
      }
    }, 5000);

    const offMsg = transport.onRawMessage((raw) => {
      let msg: AnyMessage;
      try {
        msg = decode(raw);
      } catch {
        return;
      }
      if (msg.type === "channel_created") {
        done = true;
        clearTimeout(timeout);
        offMsg();
        offStatus();
        transport.disconnect();
        resolve(msg.channelId);
      } else if (msg.type === "error") {
        done = true;
        clearTimeout(timeout);
        offMsg();
        offStatus();
        transport.disconnect();
        reject(new Error(`${msg.code}: ${msg.message}`));
      }
    });

    const offStatus = transport.onStatus((s) => {
      if (s === "open") {
        try {
          transport.sendRaw(encode({ type: "create_channel" }));
        } catch (e) {
          done = true;
          clearTimeout(timeout);
          offMsg();
          offStatus();
          transport.disconnect();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      } else if (s === "error") {
        // wait for close or timeout
      }
    });

    transport.connect();
  });
}

export class ChannelStore {
  channelId: string = $state("");
  messages: BroadcastMessage[] = $state([]);
  online: number = $state(0);
  status: TransportStatus = $state("idle");
  error: string | null = $state(null);

  private transport: Transport;
  private crypto: Crypto;
  private unsubMessage: (() => void) | null = null;
  private unsubStatus: (() => void) | null = null;

  constructor(channelId: string, crypto: Crypto = noopCrypto) {
    this.channelId = channelId;
    this.crypto = crypto;
    this.transport = new Transport(getWsUrl());

    this.unsubStatus = this.transport.onStatus((s) => {
      this.status = s;
      if (s === "open") {
        this.error = null;
        this.sendJoin();
      }
    });

    this.unsubMessage = this.transport.onRawMessage(async (raw) => {
      let msg: AnyMessage;
      try {
        msg = decode(raw);
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        return;
      }
      switch (msg.type) {
        case "joined":
          this.online = msg.online;
          break;
        case "message": {
          let payload: string;
          try {
            payload = await this.crypto.decrypt(msg.payload);
          } catch {
            this.error = "decrypt failed (wrong key or corrupted)";
            // show placeholder instead of raw ciphertext
            payload = "⚠️ decrypt failed";
          }
          this.messages = [...this.messages, { ...msg, payload }];
          break;
        }
        case "online_count":
          this.online = msg.count;
          break;
        case "error":
          this.error = `${msg.code}: ${msg.message}`;
          break;
        case "channel_created":
          break;
        case "left":
          // authoritative is online_count, ignore left
          break;
        default:
          break;
      }
    });
  }

  connect(): void {
    this.transport.connect();
  }

  disconnect(): void {
    // explicit leave is optional; authoritative is WS close + heartbeat
    // we still try graceful leave for UX but server will handle via LeaveAll
    try {
      const raw = encode({ type: "leave_channel", channelId: this.channelId });
      this.transport.sendRaw(raw);
    } catch {
      // ignore
    }
    this.transport.disconnect();
    this.unsubMessage?.();
    this.unsubStatus?.();
    this.unsubMessage = null;
    this.unsubStatus = null;
  }

  private sendJoin(): void {
    try {
      const raw = encode({ type: "join_channel", channelId: this.channelId });
      const ok = this.transport.sendRaw(raw);
      if (!ok) {
        // will be queued and retried on reconnect
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  async sendMessage(text: string): Promise<boolean> {
    if (!text.trim()) return false;
    let payload = text;
    try {
      payload = await this.crypto.encrypt(text);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
    try {
      const raw = encode({ type: "send_message", channelId: this.channelId, payload });
      const ok = this.transport.sendRaw(raw);
      if (!ok) {
        this.error = "not connected (queued)";
        return false;
      }
      this.error = null;
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }
}
