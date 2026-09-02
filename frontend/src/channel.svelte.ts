// channel.svelte.ts — UI state only, composes transport + codec + e2ee
import { Transport, type TransportStatus } from "./transport.ts";
import { encode, decode, type AnyMessage } from "./codec.ts";
import {
  noopCrypto,
  type Crypto,
  isValidEnvelope,
  extractMessageIdB64,
  ReplayCache,
  unwrapNewKey,
  unwrapRoomName,
  unwrapNick,
  createAesGcmCrypto,
  importRoomKey,
} from "./e2ee.ts";
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

export type ChatMessage = BroadcastMessage & {
  ts: number;
  /** structured system message; nick is resolved at render time (echoes arrive after the frame) */
  sys?: { sysKind: "room_name" | "key_rotation"; actor: string };
};

export type ChannelStoreOptions = {
  onKeyRotated?: (newKeyB64: string, newCrypto: Crypto) => void;
  onRoomNameUpdated?: (name: string, from: string) => void;
  onNicknameUpdated?: (from: string, nick: string) => void;
};

export class ChannelStore {
  channelId: string = $state("");
  messages: ChatMessage[] = $state([]);
  online: number = $state(0);
  status: TransportStatus = $state("idle");
  error: string | null = $state(null);

  private transport: Transport;
  private crypto: Crypto;
  private unsubMessage: (() => void) | null = null;
  private unsubStatus: (() => void) | null = null;
  private replayCache = new ReplayCache(1000);
  private lastRoomName: string | null = null;
  private onKeyRotated?: (newKeyB64: string, newCrypto: Crypto) => void;
  private onRoomNameUpdated?: (name: string, from: string) => void;
  private onNicknameUpdated?: (from: string, nick: string) => void;

  constructor(channelId: string, crypto: Crypto = noopCrypto, opts: ChannelStoreOptions = {}) {
    this.channelId = channelId;
    this.crypto = crypto;
    this.onKeyRotated = opts.onKeyRotated;
    this.onRoomNameUpdated = opts.onRoomNameUpdated;
    this.onNicknameUpdated = opts.onNicknameUpdated;
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
          // envelope sanity + replay protection (P5)
          if (!isValidEnvelope(msg.payload)) {
            this.error = "invalid envelope";
            const ts = Date.now();
            this.messages = [...this.messages, { ...msg, payload: "⚠️ invalid envelope", ts }];
            break;
          }
          const mid = extractMessageIdB64(msg.payload);
          if (mid && this.replayCache.has(mid)) {
            this.error = "replay dropped";
            break;
          }
          let payload: string;
          try {
            payload = await this.crypto.decrypt(msg.payload);
          } catch {
            this.error = "decrypt failed (wrong key or corrupted)";
            payload = "⚠️ decrypt failed";
          }
          if (mid) this.replayCache.add(mid);
          const ts = Date.now();
          this.messages = [...this.messages, { ...msg, payload, ts }];
          break;
        }
        case "key_updated": {
          // the rotator already switched crypto locally before this self echo
          // arrives; unwrapping the old-key payload with the new key would
          // always fail, so ignore it
          if (msg.self) break;
          if (!isValidEnvelope(msg.payload)) {
            this.error = "invalid key_update envelope";
            break;
          }
          const mid = extractMessageIdB64(msg.payload);
          if (mid && this.replayCache.has(mid)) {
            this.error = "replay dropped (key_update)";
            break;
          }
          try {
            const newKeyB64 = await unwrapNewKey(this.crypto, msg.payload);
            const newKey = await importRoomKey(newKeyB64);
            const newCrypto = createAesGcmCrypto(newKey, this.channelId);
            this.crypto = newCrypto;
            this.replayCache.clear();
            if (mid) this.replayCache.add(mid);
            this.onKeyRotated?.(newKeyB64, newCrypto);
            const ts = Date.now();
            // system message visible in timeline (actor shown as nick at render time)
            this.messages = [
              ...this.messages,
              { channelId: msg.channelId, payload: "", from: "system", self: false, ts, sys: { sysKind: "key_rotation", actor: msg.from } } as ChatMessage,
            ];
            this.error = null;
          } catch {
            this.error = "key rotation failed (decrypt/import)";
          }
          break;
        }
        case "room_name_updated": {
          if (!isValidEnvelope(msg.payload)) {
            this.error = "invalid room_name envelope";
            break;
          }
          const mid = extractMessageIdB64(msg.payload);
          if (mid && this.replayCache.has(mid)) {
            this.error = "replay dropped (room_name)";
            break;
          }
          try {
            const name = await unwrapRoomName(this.crypto, msg.payload);
            if (mid) this.replayCache.add(mid);
            // dedup system reminder: same name don't spam
            if (this.lastRoomName !== null && this.lastRoomName === name) {
              this.onRoomNameUpdated?.(name, msg.from);
              break;
            }
            this.lastRoomName = name;
            this.onRoomNameUpdated?.(name, msg.from);
            const ts = Date.now();
            this.messages = [
              ...this.messages,
              { channelId: msg.channelId, payload: name, from: "system", self: false, ts, sys: { sysKind: "room_name", actor: msg.from } } as ChatMessage,
            ];
            this.error = null;
          } catch {
            this.error = "room_name update failed";
          }
          break;
        }
        case "nickname_updated": {
          if (!isValidEnvelope(msg.payload)) {
            this.error = "invalid nick envelope";
            break;
          }
          const mid = extractMessageIdB64(msg.payload);
          if (mid && this.replayCache.has(mid)) {
            this.error = "replay dropped (nick)";
            break;
          }
          try {
            const nick = await unwrapNick(this.crypto, msg.payload);
            if (mid) this.replayCache.add(mid);
            this.onNicknameUpdated?.(msg.from, nick);
            this.error = null;
          } catch {
            this.error = "nickname update failed";
          }
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

  /** Allow App to update crypto after local rotation */
  updateCrypto(crypto: Crypto): void {
    this.crypto = crypto;
    this.replayCache.clear();
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

  async sendKeyUpdate(wrappedPayload: string): Promise<boolean> {
    try {
      const raw = encode({ type: "key_update", channelId: this.channelId, payload: wrappedPayload });
      const ok = this.transport.sendRaw(raw);
      if (!ok) {
        this.error = "not connected (queued)";
        return false;
      }
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async sendSetRoomName(wrappedPayload: string): Promise<boolean> {
    try {
      const raw = encode({ type: "set_room_name", channelId: this.channelId, payload: wrappedPayload });
      const ok = this.transport.sendRaw(raw);
      if (!ok) {
        this.error = "not connected (queued)";
        return false;
      }
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async sendSetNickname(wrappedPayload: string): Promise<boolean> {
    try {
      const raw = encode({ type: "set_nickname", channelId: this.channelId, payload: wrappedPayload });
      const ok = this.transport.sendRaw(raw);
      if (!ok) {
        this.error = "not connected (queued)";
        return false;
      }
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }
}
