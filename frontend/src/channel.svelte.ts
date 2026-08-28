// channel.svelte.ts — UI state only, composes transport + codec + e2ee
import { Transport, type TransportStatus } from "./transport.ts";
import { encode, decode, type AnyMessage } from "./codec.ts";
import { noopCrypto, type Crypto } from "./e2ee.ts";
import type { BroadcastMessage } from "./protocol.gen.ts";

function getWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
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
        // auto-join on open
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
      // P0: payload is plaintext, P2 will decrypt here
      // For now, handle server messages
      switch (msg.type) {
        case "joined":
          this.online = msg.online;
          break;
        case "message": {
          let payload = msg.payload;
          try {
            payload = await this.crypto.decrypt(payload);
          } catch {
            // if decrypt fails, keep raw
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
          // not expected after join, but update id if needed
          break;
        case "left":
          // handle peer left? For P0, ignore
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
    if (this.channelId) {
      try {
        const raw = encode({ type: "leave_channel", channelId: this.channelId });
        this.transport.sendRaw(raw);
      } catch {
        // ignore
      }
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
      this.transport.sendRaw(raw);
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
        this.error = "not connected";
        return false;
      }
      // Optimistic local echo? For P0, server will echo or broadcast; we don't add locally.
      // But if server is echo mode, message will come back as "message" with from.
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }
}
