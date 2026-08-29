<script lang="ts">
  import { ChannelStore, createChannel, type ChatMessage } from "./channel.svelte.ts";
  import Sidebar, { type RoomEntry } from "./Sidebar.svelte";
  import MessageList from "./MessageList.svelte";
  import Composer from "./Composer.svelte";
  import {
    generateRoomKey,
    exportRoomKey,
    importRoomKey,
    createAesGcmCrypto,
    isCryptoAvailable,
  } from "./e2ee.ts";

  let path = $state(window.location.pathname);
  let channelStore: ChannelStore | null = $state(null);
  let input = $state("");
  let joinInput = $state("");
  let creating = $state(false);
  let createError: string | null = $state(null);
  let messagesEl: HTMLDivElement | null = $state(null);
  let keyInput = $state("");
  let keyError: string | null = $state(null);

  // joined room history for sidebar (in-memory, this tab only)
  let roomHistory = $state<{ id: string; online: number; connected: boolean }[]>([]);

  const roomKeys = new Map<string, CryptoKey>();

  function navigate(to: string) {
    history.pushState({}, "", to);
    path = window.location.pathname;
    if (to.includes("#")) location.hash = to.slice(to.indexOf("#"));
  }
  window.addEventListener("popstate", () => (path = window.location.pathname));
  window.addEventListener("hashchange", () => (path = window.location.pathname));

  let channelId = $derived(
    path.startsWith("/r/") ? path.slice(3).split("/")[0].split("?")[0].split("#")[0] : ""
  );
  let hashKey = $derived.by(() => {
    const h = location.hash;
    if (!h) return null;
    const m = h.match(/[#&]k=([^&]+)/) || h.match(/[#&]key=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  });

  // keep sidebar history in sync with active room state
  $effect(() => {
    const id = channelId;
    if (!id) return;
    const online = channelStore?.online ?? 0;
    const connected = channelStore?.status === "open";
    const existing = roomHistory.find((r) => r.id === id);
    if (existing) {
      existing.online = online;
      existing.connected = connected;
    } else {
      roomHistory = [...roomHistory, { id, online, connected }];
    }
  });

  let sidebarRooms = $derived.by<RoomEntry[]>(() => {
    const active: RoomEntry = {
      id: channelId,
      online: channelStore?.online ?? 0,
      connected: channelStore?.status === "open",
    };
    const others = roomHistory
      .filter((r) => r.id !== channelId)
      .map((r) => ({ ...r, connected: false }));
    return channelId ? [active, ...others] : others;
  });

  function shortId(id: string): string {
    return id.length > 6 ? id.slice(0, 6) : id;
  }

  function hashColor(str: string): string {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 65% 45%)`;
  }

  async function getCryptoForChannel(id: string, hashB64: string | null) {
    if (!isCryptoAvailable()) throw new Error("Web Crypto unavailable - need HTTPS or localhost");
    if (hashB64) {
      const k = await importRoomKey(hashB64).catch(() => {
        throw new Error("invalid key in link");
      });
      roomKeys.set(id, k);
      keyInput = "";
      return createAesGcmCrypto(k, id);
    }
    const k = roomKeys.get(id);
    if (k) return createAesGcmCrypto(k, id);
    if (keyInput.trim()) {
      const k2 = await importRoomKey(keyInput.trim()).catch(() => {
        throw new Error("invalid pasted key");
      });
      roomKeys.set(id, k2);
      const b64 = keyInput.trim();
      history.replaceState({}, "", `${location.pathname}#k=${encodeURIComponent(b64)}`);
      keyInput = "";
      return createAesGcmCrypto(k2, id);
    }
    throw new Error("missing room key - paste key from invite link");
  }

  $effect(() => {
    const id = channelId;
    const hk = hashKey;
    void keyInput;
    if (!id) {
      channelStore?.disconnect();
      channelStore = null;
      return;
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return;
    let cancelled = false;
    let store: ChannelStore | null = null;
    (async () => {
      try {
        if (!isCryptoAvailable()) throw new Error("E2EE requires HTTPS or localhost");
        const crypto = await getCryptoForChannel(id, hk);
        if (cancelled) return;
        const s = new ChannelStore(id, crypto);
        store = s;
        channelStore = s;
        s.connect();
        keyError = null;
      } catch (e) {
        keyError = e instanceof Error ? e.message : String(e);
        channelStore?.disconnect();
        channelStore = null;
      }
    })();
    return () => {
      cancelled = true;
      store?.disconnect();
      if (channelStore === store) channelStore = null;
    };
  });

  $effect(() => {
    if (channelStore?.messages.length && messagesEl) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  });

  async function handleSend() {
    if (!channelStore || !input.trim()) return;
    const ok = await channelStore.sendMessage(input);
    if (ok) input = "";
  }
  async function createRoom() {
    if (creating) return;
    creating = true;
    createError = null;
    try {
      if (!isCryptoAvailable()) throw new Error("Web Crypto unavailable");
      const tmpKey = await generateRoomKey();
      const keyB64 = await exportRoomKey(tmpKey);
      const key = await importRoomKey(keyB64);
      const id = await createChannel();
      roomKeys.set(id, key);
      navigate(`/r/${id}#k=${encodeURIComponent(keyB64)}`);
    } catch (e) {
      createError = e instanceof Error ? e.message : String(e);
    } finally {
      creating = false;
    }
  }
  function parseInvite(raw: string): { id: string; key: string | null } {
    const s = raw.trim();
    const m = s.match(/\/r\/([a-zA-Z0-9_-]{1,64})(?:#k=([^&\s]+))?/);
    if (m) return { id: m[1], key: m[2] ? decodeURIComponent(m[2]) : null };
    return { id: s, key: null };
  }
  function joinRoom() {
    const { id, key } = parseInvite(joinInput);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      alert("Invalid room id. Use 1-64 chars: a-z, A-Z, 0-9, _ -");
      return;
    }
    const k = key ?? (keyInput.trim() || null);
    if (k) navigate(`/r/${id}#k=${encodeURIComponent(k)}`);
    else navigate(`/r/${id}`);
  }
  function leaveRoom() {
    if (channelId) roomKeys.delete(channelId);
    keyInput = "";
    channelStore?.disconnect();
    navigate("/");
  }
  async function importPastedKey() {
    keyError = null;
    try {
      const b64 = keyInput.trim();
      if (!b64) throw new Error("empty key");
      const k = await importRoomKey(b64);
      if (!channelId) throw new Error("no channel");
      roomKeys.set(channelId, k);
      history.replaceState({}, "", `${location.pathname}#k=${encodeURIComponent(b64)}`);
      keyInput = "";
      path = window.location.pathname;
    } catch (e) {
      keyError = e instanceof Error ? e.message : String(e);
    }
  }
  function copyInviteLink() {
    navigator.clipboard.writeText(location.href);
  }
  function copyText(t: string) {
    navigator.clipboard.writeText(t);
  }
  function deleteMessage(idx: number) {
    if (!channelStore) return;
    channelStore.messages = channelStore.messages.filter((_, i) => i !== idx);
  }
  function clearLocalMessages() {
    if (!channelStore) return;
    channelStore.messages = [];
  }
  function navigateToRoom(id: string) {
    const k = roomKeys.has(id) ? null : null; // keys are in-memory; hash only if we still store b64 — we don't
    void k;
    navigate(`/r/${id}`);
  }
</script>

<div class="flex h-screen bg-surface-subtle font-sans text-zinc-900 antialiased">
    <Sidebar
      rooms={sidebarRooms}
      activeId={channelId}
      {creating}
      bind:joinInput
      onCreate={createRoom}
      onJoin={joinRoom}
      onNavigate={navigateToRoom}
    />

  <main class="flex min-w-0 flex-1 flex-col bg-surface">
    {#if path === "/"}
      <!-- Home: hero in main area -->
      <div class="flex flex-1 items-center justify-center p-8">
        <div class="max-w-md text-center">
          <div class="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand text-white">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <rect x="4" y="11" width="16" height="9" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
          </div>
          <h1 class="mt-5 text-3xl font-bold tracking-tight">Private Chat</h1>
          <p class="mt-2 text-sm text-zinc-500">
            No account · No contacts · Rooms only · E2EE in browser
          </p>
          <p class="mt-6 text-xs text-zinc-400">
            Create a room from the sidebar, or paste an invite link into Join Room.
          </p>
          {#if createError}<p class="mt-4 text-xs text-red-600">{createError}</p>{/if}
          {#if !isCryptoAvailable()}
            <p class="mt-4 text-xs text-red-600">Web Crypto unavailable — need HTTPS or localhost (no downgrade)</p>
          {/if}
        </div>
      </div>
    {:else if path.startsWith("/r/")}
      <!-- Room header -->
      <div class="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 px-5">
        <div class="flex items-center gap-3">
          <button
            class="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
            title="Leave room"
            aria-label="Leave room"
            onclick={leaveRoom}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <span class="text-lg font-bold tracking-tight">Room: {shortId(channelId)}</span>
          {#if channelStore}
            <span class="flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs text-zinc-600">
              <span
                class="h-2 w-2 rounded-full {channelStore.status === 'open'
                  ? 'bg-ok'
                  : channelStore.status === 'reconnecting'
                    ? 'bg-amber-400'
                    : 'bg-zinc-300'}"
              ></span>
              {channelStore.online} online
            </span>
          {:else}
            <span class="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs text-amber-700">need key</span>
          {/if}
        </div>
        <div class="flex items-center gap-1">
          <button
            class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-brand hover:bg-brand-subtle"
            onclick={copyInviteLink}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            Copy link
          </button>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-red-600"
            title="Clear local chat"
            aria-label="Clear local chat"
            onclick={clearLocalMessages}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
          </button>
        </div>
      </div>

      {#if keyError}
        <div class="mx-5 mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-700">{keyError}</div>
      {/if}
      {#if channelStore?.error}
        <div class="mx-5 mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{channelStore.error}</div>
      {/if}

      {#if !/^[a-zA-Z0-9_-]{1,64}$/.test(channelId)}
        <div class="mx-5 mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Invalid room id
        </div>
      {:else if !channelStore}
        <div class="mx-5 mt-4 rounded-xl border border-amber-200 bg-amber-50 p-5">
          <p class="text-sm font-medium">Enter room key to decrypt</p>
          <p class="mt-1 text-xs text-zinc-600">
            This room is E2EE. Paste the base64url key from the invite link (#k=...). Key never leaves your device.
          </p>
          <div class="mt-3 flex gap-2">
            <input
              class="h-9 min-w-0 flex-1 rounded-lg border border-zinc-200 bg-surface px-3 text-xs outline-none focus:border-brand"
              placeholder="paste key (43 chars base64url)"
              bind:value={keyInput}
            />
            <button class="rounded-lg bg-brand px-4 py-2 text-xs font-medium text-white hover:bg-brand-hover" onclick={importPastedKey}>
              Use key
            </button>
          </div>
          {#if keyError}<p class="mt-2 text-xs text-red-600">{keyError}</p>{/if}
        </div>
      {:else}
        <!-- Messages -->
        <div bind:this={messagesEl} class="min-h-0 flex-1 overflow-y-auto px-5 py-6">
          {#if channelStore.messages.length === 0}
            <div class="flex gap-3">
              <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-bold text-white">S</div>
              <div>
                <div class="mb-1 text-sm font-medium text-zinc-700">System</div>
                <div class="inline-block rounded-2xl rounded-tl-md bg-zinc-100 px-4 py-2.5 text-sm">
                  Hello, I'm your private room. Invite someone with the link.
                </div>
                <div class="mt-1 text-xs text-zinc-400">
                  {channelStore.status} · {channelStore.online} online
                  {#if channelStore.status === "reconnecting"}· reconnecting (up to 10s){/if}
                </div>
              </div>
            </div>
          {:else}
            <MessageList
              messages={channelStore.messages as ChatMessage[]}
              onCopy={copyText}
              onDelete={deleteMessage}
            />
          {/if}
        </div>

        <!-- Composer -->
        <div class="shrink-0 border-t border-zinc-200">
          <Composer
            bind:input
            disabled={!isCryptoAvailable()}
            canSend={!!input.trim() && channelStore.status === "open"}
            onSend={handleSend}
            onClear={clearLocalMessages}
          />
          <p class="pb-2 text-center text-[11px] text-zinc-400">
            E2EE · 12B IV + 16B messageId · AAD v1|channelId|messageId · key in memory only · server sees ciphertext
          </p>
        </div>
      {/if}
    {:else}
      <div class="flex flex-1 items-center justify-center p-8">
        <p class="text-sm text-zinc-500">Not found</p>
      </div>
    {/if}
  </main>
</div>
