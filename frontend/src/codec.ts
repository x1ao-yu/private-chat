// codec.ts — protocol encode/decode only
// Depends on protocol.gen.ts. No WebSocket, no E2EE, no UI state.

import type {
  ChatProtocol,
  CreateChannel,
  JoinChannel,
  LeaveChannel,
  SendMessage,
  KeyUpdate,
  SetRoomName,
  SetNickname,
  ChannelCreated,
  Joined,
  Left,
  BroadcastMessage,
  KeyUpdated,
  RoomNameUpdated,
  NicknameUpdated,
  OnlineCount,
  Error as ProtocolError,
} from "./protocol.gen.ts";

export type ClientMessage = CreateChannel | JoinChannel | LeaveChannel | SendMessage | KeyUpdate | SetRoomName | SetNickname;
export type ServerMessage =
  | ChannelCreated
  | Joined
  | Left
  | BroadcastMessage
  | KeyUpdated
  | RoomNameUpdated
  | NicknameUpdated
  | OnlineCount
  | ProtocolError;
export type AnyMessage = ChatProtocol;

const CLIENT_TYPES = new Set([
  "create_channel",
  "join_channel",
  "leave_channel",
  "send_message",
  "key_update",
  "set_room_name",
  "set_nickname",
]);
const SERVER_TYPES = new Set([
  "channel_created",
  "joined",
  "left",
  "message",
  "key_updated",
  "room_name_updated",
  "nickname_updated",
  "online_count",
  "error",
]);
const ALL_TYPES = new Set([...CLIENT_TYPES, ...SERVER_TYPES]);

const CHANNEL_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertChannelId(id: unknown): void {
  if (typeof id !== "string" || !CHANNEL_ID_RE.test(id)) {
    throw new Error(`invalid channelId: ${String(id)}`);
  }
}

function assertPayload(p: unknown): void {
  if (typeof p !== "string") throw new Error("invalid payload: not string");
  // 8192 is wire limit (payload string length on the wire), not plaintext limit.
  // After E2EE, payload is base64url(iv).base64url(messageId).base64url(ct+tag); plaintext budget ~5-6k.
  if (p.length > 8192) throw new Error("payload too large");
}

export function encode(msg: AnyMessage): string {
  // Basic validation before stringify to catch programming errors early
  if (!isObject(msg) || typeof (msg as Record<string, unknown>).type !== "string") {
    throw new Error("invalid message: missing type");
  }
  const t = (msg as Record<string, unknown>).type as string;
  if (!ALL_TYPES.has(t)) {
    throw new Error(`unknown message type: ${t}`);
  }
  // Per-type checks
  switch (t) {
    case "join_channel":
    case "leave_channel":
    case "channel_created":
    case "left":
      assertChannelId((msg as JoinChannel).channelId);
      break;
    case "send_message":
      assertChannelId((msg as SendMessage).channelId);
      assertPayload((msg as SendMessage).payload);
      break;
    case "key_update":
      assertChannelId((msg as KeyUpdate).channelId);
      assertPayload((msg as KeyUpdate).payload);
      break;
    case "set_room_name":
      assertChannelId((msg as SetRoomName).channelId);
      assertPayload((msg as SetRoomName).payload);
      break;
    case "set_nickname":
      assertChannelId((msg as SetNickname).channelId);
      assertPayload((msg as SetNickname).payload);
      break;
    case "joined":
      assertChannelId((msg as Joined).channelId);
      if (typeof (msg as Joined).online !== "number" || (msg as Joined).online < 1) {
        throw new Error("invalid online");
      }
      break;
    case "message":
      assertChannelId((msg as BroadcastMessage).channelId);
      assertPayload((msg as BroadcastMessage).payload);
      if (typeof (msg as BroadcastMessage).from !== "string" || (msg as BroadcastMessage).from.length === 0) {
        throw new Error("invalid from");
      }
      break;
    case "key_updated":
      assertChannelId((msg as KeyUpdated).channelId);
      assertPayload((msg as KeyUpdated).payload);
      if (typeof (msg as KeyUpdated).from !== "string" || (msg as KeyUpdated).from.length === 0) {
        throw new Error("invalid from");
      }
      break;
    case "room_name_updated":
      assertChannelId((msg as RoomNameUpdated).channelId);
      assertPayload((msg as RoomNameUpdated).payload);
      if (typeof (msg as RoomNameUpdated).from !== "string" || (msg as RoomNameUpdated).from.length === 0) {
        throw new Error("invalid from");
      }
      break;
    case "nickname_updated":
      assertChannelId((msg as NicknameUpdated).channelId);
      assertPayload((msg as NicknameUpdated).payload);
      if (typeof (msg as NicknameUpdated).from !== "string" || (msg as NicknameUpdated).from.length === 0) {
        throw new Error("invalid from");
      }
      break;
    case "online_count":
      assertChannelId((msg as OnlineCount).channelId);
      if (typeof (msg as OnlineCount).count !== "number" || (msg as OnlineCount).count < 0) {
        throw new Error("invalid count");
      }
      break;
    case "error": {
      const e = msg as ProtocolError;
      if (!["invalid_message", "channel_not_found", "rate_limited", "internal_error"].includes(e.code)) {
        throw new Error(`invalid error code: ${e.code}`);
      }
      break;
    }
    case "create_channel":
      break;
    default:
      throw new Error(`unhandled type: ${t}`);
  }
  return JSON.stringify(msg);
}

export function decode(raw: string): AnyMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid JSON");
  }
  if (!isObject(parsed) || typeof parsed.type !== "string") {
    throw new Error("invalid message: missing type");
  }
  const t = parsed.type as string;
  if (!ALL_TYPES.has(t)) {
    throw new Error(`unknown message type: ${t}`);
  }
  // Validate required fields exist (lightweight, schema validation is server-side via go-jsonschema)
  switch (t) {
    case "create_channel":
      return parsed as unknown as CreateChannel;
    case "join_channel":
      if (typeof parsed.channelId !== "string") throw new Error("missing channelId");
      assertChannelId(parsed.channelId);
      return parsed as unknown as JoinChannel;
    case "leave_channel":
      if (typeof parsed.channelId !== "string") throw new Error("missing channelId");
      assertChannelId(parsed.channelId);
      return parsed as unknown as LeaveChannel;
    case "send_message":
      if (typeof parsed.channelId !== "string") throw new Error("missing channelId");
      if (typeof parsed.payload !== "string") throw new Error("missing payload");
      assertChannelId(parsed.channelId);
      assertPayload(parsed.payload);
      return parsed as unknown as SendMessage;
    case "key_update":
      if (typeof parsed.channelId !== "string") throw new Error("missing channelId");
      if (typeof parsed.payload !== "string") throw new Error("missing payload");
      assertChannelId(parsed.channelId);
      assertPayload(parsed.payload);
      return parsed as unknown as KeyUpdate;
    case "set_room_name":
      if (typeof parsed.channelId !== "string") throw new Error("missing channelId");
      if (typeof parsed.payload !== "string") throw new Error("missing payload");
      assertChannelId(parsed.channelId);
      assertPayload(parsed.payload);
      return parsed as unknown as SetRoomName;
    case "set_nickname":
      if (typeof parsed.channelId !== "string") throw new Error("missing channelId");
      if (typeof parsed.payload !== "string") throw new Error("missing payload");
      assertChannelId(parsed.channelId);
      assertPayload(parsed.payload);
      return parsed as unknown as SetNickname;
    case "channel_created":
      if (typeof parsed.channelId !== "string") throw new Error("missing channelId");
      assertChannelId(parsed.channelId);
      return parsed as unknown as ChannelCreated;
    case "joined":
      if (typeof parsed.channelId !== "string") throw new Error("missing channelId");
      if (typeof parsed.online !== "number") throw new Error("missing online");
      return parsed as unknown as Joined;
    case "left":
      if (typeof parsed.channelId !== "string") throw new Error("missing channelId");
      return parsed as unknown as Left;
    case "message":
      if (typeof parsed.channelId !== "string") throw new Error("missing channelId");
      if (typeof parsed.payload !== "string") throw new Error("missing payload");
      if (typeof parsed.from !== "string") throw new Error("missing from");
      return parsed as unknown as BroadcastMessage;
    case "key_updated":
      if (typeof parsed.channelId !== "string") throw new Error("missing channelId");
      if (typeof parsed.payload !== "string") throw new Error("missing payload");
      if (typeof parsed.from !== "string") throw new Error("missing from");
      return parsed as unknown as KeyUpdated;
    case "room_name_updated":
      if (typeof parsed.channelId !== "string") throw new Error("missing channelId");
      if (typeof parsed.payload !== "string") throw new Error("missing payload");
      if (typeof parsed.from !== "string") throw new Error("missing from");
      return parsed as unknown as RoomNameUpdated;
    case "nickname_updated":
      if (typeof parsed.channelId !== "string") throw new Error("missing channelId");
      if (typeof parsed.payload !== "string") throw new Error("missing payload");
      if (typeof parsed.from !== "string") throw new Error("missing from");
      return parsed as unknown as NicknameUpdated;
    case "online_count":
      if (typeof parsed.channelId !== "string") throw new Error("missing channelId");
      if (typeof parsed.count !== "number") throw new Error("missing count");
      return parsed as unknown as OnlineCount;
    case "error":
      if (typeof parsed.code !== "string") throw new Error("missing code");
      if (typeof parsed.message !== "string") throw new Error("missing message");
      return parsed as unknown as ProtocolError;
    default:
      throw new Error(`unhandled type: ${t}`);
  }
}

export function isClientMessage(msg: AnyMessage): msg is ClientMessage {
  return CLIENT_TYPES.has((msg as { type: string }).type);
}

export function isServerMessage(msg: AnyMessage): msg is ServerMessage {
  return SERVER_TYPES.has((msg as { type: string }).type);
}
