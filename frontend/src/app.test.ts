import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import App from "./App.svelte";
import { MockWS, installMockWS } from "./test-helpers/mockws.ts";
import { generateRoomKey, exportRoomKey } from "./e2ee.ts";

// flush async work (crypto/identity/effect chains span several task turns)
const sleep = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

const VALID_ID = "room-app-test-1";
const OTHER_ID = "room-app-test-2";

let app: Record<string, unknown> | undefined;
let restoreWS: () => void;
let clip: string[];

function render(path = "/"): void {
  history.replaceState({}, "", path);
  app = mount(App, { target: document.body }) as Record<string, unknown>;
  flushSync();
}

function setInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function inputByPlaceholder(p: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(`input[placeholder="${p}"]`);
  if (!el) throw new Error(`input not found: ${p}`);
  return el;
}

function button(text: string): HTMLButtonElement {
  const btn = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!btn) throw new Error(`button not found: ${text}`);
  return btn;
}

function byAria(label: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  if (!el) throw new Error(`element not found: ${label}`);
  return el;
}

function byTitle(label: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[title="${label}"]`);
  if (!el) throw new Error(`element not found: ${label}`);
  return el;
}

function click(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  flushSync();
}

function sentFrames(): Record<string, unknown>[] {
  return MockWS.instances.flatMap((w) =>
    w.sent.map((s) => JSON.parse(s) as Record<string, unknown>),
  );
}

async function newRoomKeyB64(): Promise<string> {
  return exportRoomKey(await generateRoomKey());
}

/** Sidebar invite -> nickname gate -> confirm -> open the real store's WS -> join sent. */
async function joinViaInvite(roomId: string, key: string, nick: string): Promise<MockWS> {
  setInput(inputByPlaceholder("Room ID or Invite Link"), `/r/${roomId}#k=${key}`);
  click(button("Join"));
  await sleep();
  expect(window.location.pathname).toBe("/join");

  setInput(inputByPlaceholder("e.g. Bob"), nick);
  click(button("Confirm & Join"));
  await sleep();
  expect(window.location.pathname).toBe(`/r/${roomId}`);

  // [0] may be the pre-join room-name peek; the real store's socket is the newest
  const ws = MockWS.instances[MockWS.instances.length - 1];
  ws.simulateOpen();
  await sleep();
  const join = sentFrames().find((f) => f.type === "join_channel");
  expect(join).toMatchObject({ type: "join_channel", channelId: roomId });
  return ws;
}

/** Create a room from the home page and return its id + open store socket. */
async function createAndEnter(roomName: string, nick: string): Promise<{ id: string; ws: MockWS }> {
  click(button("Create Room"));
  expect(window.location.pathname).toBe("/create");
  setInput(inputByPlaceholder("e.g. Weekend plan"), roomName);
  setInput(inputByPlaceholder("e.g. Alice"), nick);
  click(button("Create & Enter"));
  await sleep();

  const createWs = MockWS.instances[MockWS.instances.length - 1];
  createWs.simulateOpen();
  expect(JSON.parse(createWs.sent[0])).toEqual({ type: "create_channel" });
  createWs.simulateMessage(JSON.stringify({ type: "channel_created", channelId: "created01" }));
  await sleep();
  flushSync();
  expect(window.location.pathname).toBe("/r/created01");

  const storeWs = MockWS.instances[MockWS.instances.length - 1];
  storeWs.simulateOpen();
  await sleep();
  expect(sentFrames().some((f) => f.type === "join_channel")).toBe(true);
  return { id: "created01", ws: storeWs };
}

beforeEach(() => {
  restoreWS = installMockWS();
  clip = [];
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: (t: string) => {
        clip.push(t);
        return Promise.resolve();
      },
    },
    configurable: true,
  });
  vi.spyOn(window, "alert").mockImplementation(() => {});
  history.replaceState({}, "", "/");
  document.body.innerHTML = "";
});

afterEach(() => {
  if (app) {
    unmount(app as never);
    app = undefined;
  }
  flushSync();
  document.body.innerHTML = "";
  restoreWS();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  history.replaceState({}, "", "/");
});

describe("navigation", () => {
  it("renders the home hero with Web Crypto available", () => {
    render("/");
    expect(document.body.textContent).toContain("Private Chat");
    expect(document.body.textContent).toContain("No account");
    expect(document.body.textContent).not.toContain("Web Crypto unavailable");
  });

  it("navigates to the create view from the sidebar", () => {
    render("/");
    click(button("Create Room"));
    expect(window.location.pathname).toBe("/create");
    expect(document.querySelector("h2")?.textContent).toBe("Create Room");
  });

  it("shows Not found for an unknown path", () => {
    render("/bogus");
    expect(document.body.textContent).toContain("Not found");
  });

  it("shows Invalid room id for a malformed /r/ id and never joins", () => {
    render("/r/bad!");
    expect(document.body.textContent).toContain("Invalid room id");
    expect(MockWS.instances).toHaveLength(0);
    expect(window.location.pathname).toBe("/r/bad!");
  });
});

describe("create room form", () => {
  it("keeps Create & Enter disabled while fields are empty", () => {
    render("/create");
    expect(button("Create & Enter")).toHaveProperty("disabled", true);
  });

  it("rejects an invalid room name before any network call", () => {
    render("/create");
    setInput(inputByPlaceholder("e.g. Weekend plan"), "x".repeat(33));
    setInput(inputByPlaceholder("e.g. Alice"), "Alice");
    click(button("Create & Enter"));
    expect(document.body.textContent).toContain("Room name 1-32 chars, no newline");
    expect(MockWS.instances).toHaveLength(0);
    expect(window.location.pathname).toBe("/create");
  });

  it("creates a room, never exposes the key in the URL, and joins it", async () => {
    render("/");
    const { id } = await createAndEnter("Weekend plan", "Alice");
    expect(window.location.pathname).toBe(`/r/${id}`);
    // P3: the room key must not appear in the address bar after create
    expect(window.location.hash).toBe("");
    expect(sentFrames().some((f) => f.type === "create_channel")).toBe(true);
    expect(sentFrames().some((f) => f.type === "join_channel")).toBe(true);
  });
});

describe("join input guards (P3 — reject before the network)", () => {
  it("rejects a bare 43-char room key pasted into Join", async () => {
    const key = await newRoomKeyB64();
    render("/");
    setInput(inputByPlaceholder("Room ID or Invite Link"), key);
    click(button("Join"));
    await sleep();
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining("room key, not an invite"));
    expect(window.location.pathname).toBe("/");
    expect(MockWS.instances).toHaveLength(0);
    const wire = MockWS.instances.flatMap((w) => w.sent).join("|");
    expect(wire).not.toContain(key);
  });

  it("rejects an invalid room id pasted into Join", () => {
    render("/");
    setInput(inputByPlaceholder("Room ID or Invite Link"), "bad id!");
    click(button("Join"));
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining("Invalid room id"));
    expect(window.location.pathname).toBe("/");
    expect(MockWS.instances).toHaveLength(0);
  });

  it("rejects a malformed invite key before importing it", async () => {
    render("/");
    setInput(inputByPlaceholder("Room ID or Invite Link"), `/r/${VALID_ID}#k=short`);
    click(button("Join"));
    await sleep();
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining("Invalid room key"));
    expect(window.location.pathname).toBe("/");
    expect(MockWS.instances).toHaveLength(0);
  });
});

describe("nickname gate", () => {
  it("opens the gate for a valid invite and previews without joining yet", async () => {
    const key = await newRoomKeyB64();
    render("/");
    setInput(inputByPlaceholder("Room ID or Invite Link"), `/r/${VALID_ID}#k=${key}`);
    click(button("Join"));
    await sleep();
    flushSync();
    expect(window.location.pathname).toBe("/join");
    expect(document.querySelector("h2")?.textContent).toBe("Join Room");
    // no join_channel until the nick is confirmed (peek may hold a socket, unopened)
    expect(sentFrames().some((f) => f.type === "join_channel")).toBe(false);
  });

  it("shows the gate on a direct /r/:id landing without a nick", async () => {
    render(`/r/${VALID_ID}`);
    await sleep();
    flushSync();
    expect(window.location.pathname).toBe("/join");
    expect(document.querySelector("h2")?.textContent).toBe("Join Room");
    expect(sentFrames().some((f) => f.type === "join_channel")).toBe(false);
  });

  it("strips #k= from the URL on a direct invite landing and never sends the key", async () => {
    const key = await newRoomKeyB64();
    render(`/r/${VALID_ID}#k=${key}`);
    await sleep();
    flushSync();
    expect(window.location.pathname).toBe("/join");
    // hash left the address bar as soon as the gate navigation ran
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(key);
    const wire = MockWS.instances.flatMap((w) => w.sent).join("|");
    expect(wire).not.toContain(key);
  });

  it("rejects an invalid nickname at the gate", async () => {
    const key = await newRoomKeyB64();
    render("/");
    setInput(inputByPlaceholder("Room ID or Invite Link"), `/r/${VALID_ID}#k=${key}`);
    click(button("Join"));
    await sleep();
    setInput(inputByPlaceholder("e.g. Bob"), "x".repeat(21));
    click(button("Confirm & Join"));
    await sleep();
    expect(document.body.textContent).toContain("Nickname 1-20 chars, no newline (required)");
    expect(window.location.pathname).toBe("/join");
    expect(sentFrames().some((f) => f.type === "join_channel")).toBe(false);
  });

  it("cancels back to home without joining", async () => {
    const key = await newRoomKeyB64();
    render("/");
    setInput(inputByPlaceholder("Room ID or Invite Link"), `/r/${VALID_ID}#k=${key}`);
    click(button("Join"));
    await sleep();
    click(button("Cancel"));
    expect(window.location.pathname).toBe("/");
    expect(sentFrames().some((f) => f.type === "join_channel")).toBe(false);
  });

  it("confirms with a valid nick and sends join_channel", async () => {
    const key = await newRoomKeyB64();
    render("/");
    await joinViaInvite(VALID_ID, key, "Bob");
    expect(window.location.pathname).toBe(`/r/${VALID_ID}`);
  });
});

describe("key rotation", () => {
  it("Rotate locally swaps the key without broadcasting key_update", async () => {
    const key = await newRoomKeyB64();
    render("/");
    await joinViaInvite(VALID_ID, key, "Bob");
    clip.length = 0;

    click(button("Rotate locally"));
    await sleep();

    expect(sentFrames().some((f) => f.type === "key_update")).toBe(false);
    expect(clip).toHaveLength(1);
    expect(clip[0]).toContain(`/r/${VALID_ID}#k=`);
    const newKey = clip[0].split("#k=")[1];
    expect(newKey).toBeDefined();
    expect(newKey).not.toBe(key);
    expect(document.body.textContent).toContain("Key rotated locally");
    expect(window.location.hash).toBe("");
  });

  it("Rotate & share broadcasts key_update over the wire", async () => {
    const key = await newRoomKeyB64();
    render("/");
    await joinViaInvite(VALID_ID, key, "Bob");
    clip.length = 0;

    click(button("Rotate & share"));
    await sleep();

    const update = sentFrames().find((f) => f.type === "key_update");
    expect(update).toMatchObject({ channelId: VALID_ID });
    expect(typeof update?.payload).toBe("string");
  });
});

describe("leave and sidebar", () => {
  it("leaves the room: leave_channel sent, back home, room dropped from sidebar", async () => {
    const key = await newRoomKeyB64();
    render("/");
    await joinViaInvite(VALID_ID, key, "Bob");

    click(byAria("Leave room"));
    await sleep();

    expect(sentFrames().some((f) => f.type === "leave_channel")).toBe(true);
    expect(window.location.pathname).toBe("/");
    expect(document.body.textContent).not.toContain(VALID_ID);
  });

  it("sidebar Create Room navigates away while the connected room stays listed", async () => {
    const key = await newRoomKeyB64();
    render("/");
    await joinViaInvite(VALID_ID, key, "Bob");
    // sidebar is present in the room view — navigate to create without leaving
    const sidebarCreate = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Create Room",
    );
    expect(sidebarCreate).toBeDefined();
    click(sidebarCreate!);
    expect(window.location.pathname).toBe("/create");
    // the connected room remains visible in the sidebar (multi-room view switch)
    expect(document.body.textContent).toContain(VALID_ID);
    expect(sentFrames().some((f) => f.type === "leave_channel")).toBe(false);
  });

  it("copies an invite link rebuilt from the in-memory key", async () => {
    const key = await newRoomKeyB64();
    render("/");
    await joinViaInvite(VALID_ID, key, "Bob");
    clip.length = 0;

    click(button("Copy link"));
    await sleep();

    expect(clip).toHaveLength(1);
    expect(clip[0]).toBe(`${window.location.origin}/r/${VALID_ID}#k=${key}`);
    expect(window.location.hash).toBe("");
  });
});

describe("room name editing", () => {
  it("rejects an invalid room name with a visible error", async () => {
    const key = await newRoomKeyB64();
    render("/");
    await joinViaInvite(VALID_ID, key, "Bob");

    click(byTitle("Edit room name"));
    const draft = inputByPlaceholder("Room name 1-32");
    setInput(draft, "x".repeat(33));
    click(button("Save"));

    expect(document.body.textContent).toContain("Room name 1-32 chars");
    expect(sentFrames().some((f) => f.type === "set_room_name")).toBe(false);
  });
});

describe("multi-room", () => {
  it("keeps independent rooms isolated in the sidebar", async () => {
    const keyA = await newRoomKeyB64();
    render("/");
    await joinViaInvite(VALID_ID, keyA, "Bob");

    // switch to create, make a second room (separate store + socket)
    click(button("Create Room"));
    setInput(inputByPlaceholder("e.g. Weekend plan"), "Second room");
    setInput(inputByPlaceholder("e.g. Alice"), "Carol");
    click(button("Create & Enter"));
    await sleep();
    const createWs = MockWS.instances[MockWS.instances.length - 1];
    createWs.simulateOpen();
    createWs.simulateMessage(JSON.stringify({ type: "channel_created", channelId: OTHER_ID }));
    await sleep();
    flushSync();

    expect(window.location.pathname).toBe(`/r/${OTHER_ID}`);
    const storeWs = MockWS.instances[MockWS.instances.length - 1];
    storeWs.simulateOpen();
    await sleep();
    // both rooms listed; neither leave_channel was sent
    expect(document.body.textContent).toContain(VALID_ID);
    expect(sentFrames().some((f) => f.type === "leave_channel")).toBe(false);
    expect(sentFrames().filter((f) => f.type === "join_channel").length).toBeGreaterThanOrEqual(2);
  });
});
