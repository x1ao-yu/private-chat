<script lang="ts">
  import { ChannelStore, createChannel, type ChatMessage } from "./channel.svelte.ts";
  import Sidebar, { type RoomEntry } from "./Sidebar.svelte";
  import MessageList from "./MessageList.svelte";
  import Composer from "./Composer.svelte";
  import CreateRoomView from "./CreateRoomView.svelte";
  import JoinNickView from "./JoinNickView.svelte";
  import {
    generateRoomKey,
    exportRoomKey,
    importRoomKey,
    createAesGcmCrypto,
    isCryptoAvailable,
    isRoomKeyB64,
    wrapNewKey,
    wrapRoomName,
    wrapNick,
    isValidRoomName,
    isValidNick,
  } from "./e2ee.ts";
  import { parseInvite, parseKeyFromHash } from "./invite.ts";

  let path = $state(window.location.pathname);
  // key parsed from the current URL hash; must be $state so hash changes are seen after mount
  let pendingHashKey = $state(parseKeyFromHash(window.location.hash));
  let channelStore: ChannelStore | null = $state(null);
  let input = $state("");
  let joinInput = $state("");
  let creating = $state(false);
  let createError: string | null = $state(null);
  let messagesEl: HTMLDivElement | null = $state(null);
  let keyInput = $state("");
  let keyError: string | null = $state(null);
  let rotating = $state(false);
  let drawerOpen = $state(false);
  let createRoomName = $state("");
  let createNick = $state("");
  let joinPendingId: string | null = $state(null);
  let joinPendingKey: string | null = $state(null);
  let joinNick = $state("");
  let joinError: string | null = $state(null);
  let joinCreating = $state(false);

  // joined room history for sidebar (in-memory, this tab only)
  let roomHistory = $state<{ id: string; online: number; connected: boolean }[]>([]);

  // per-room keys, tab memory only (P3): CryptoKey for crypto, b64 copy solely
  // to rebuild invite links — never persisted, never sent to the server
  const roomKeys = new Map<string, CryptoKey>();
  const roomKeyB64 = new Map<string, string>();
  // P6 prep: display names (tab memory only, per-room, not identity)
  const roomNames = new Map<string, string>();
  const selfNicks = new Map<string, string>();
  const peerNicks = new Map<string, string>(); // `${channelId}:${from}` -> nick
  let roomNamesVersion = $state(0);
  let peerNicksVersion = $state(0);
  let editingRoomName = $state(false);
  let roomNameDraft = $state("");
  let editingNick = $state(false);
  let nickDraft = $state("");

  function navigate(to: string) {
    history.pushState({}, "", to);
    path = window.location.pathname;
    pendingHashKey = parseKeyFromHash(window.location.hash);
  }
  window.addEventListener("popstate", () => {
    path = window.location.pathname;
    pendingHashKey = parseKeyFromHash(window.location.hash);
  });
  window.addEventListener("hashchange", () => {
    path = window.location.pathname;
    pendingHashKey = parseKeyFromHash(window.location.hash);
  });

  let channelId = $derived(
    path.startsWith("/r/") ? path.slice(3).split("/")[0].split("?")[0].split("#")[0] : ""
  );

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
    void roomNamesVersion;
    void peerNicksVersion;
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
      const k = await importRoomKey(hashB64).catch((e: unknown) => {
        throw new Error(`invalid key in link: ${e instanceof Error ? e.message : String(e)}`);
      });
      roomKeys.set(id, k);
      roomKeyB64.set(id, hashB64);
      keyInput = "";
      // key consumed: strip it from the URL immediately (cleans the address bar
      // and the history entry); keep pendingHashKey as-is to avoid a reconnect re-run
      history.replaceState({}, "", location.pathname);
      return createAesGcmCrypto(k, id);
    }
    const k = roomKeys.get(id);
    if (k) return createAesGcmCrypto(k, id);
    // attempt auto-import only for well-formed keys; partial input stays quiet
    // (explicit feedback lives in importPastedKey)
    if (isRoomKeyB64(keyInput.trim())) {
      const k2 = await importRoomKey(keyInput.trim()).catch((e: unknown) => {
        throw new Error(`invalid pasted key: ${e instanceof Error ? e.message : String(e)}`);
      });
      roomKeys.set(id, k2);
      roomKeyB64.set(id, keyInput.trim());
      keyInput = "";
      return createAesGcmCrypto(k2, id);
    }
    throw new Error("missing room key - paste key from invite link");
  }

  $effect(() => {
    const id = channelId;
    const hk = pendingHashKey;
    void keyInput;
    // NOTE: intentionally NOT dependent on roomNamesVersion/peerNicksVersion —
    // display-name echoes must not rebuild the WS connection (a rebuild sends
    // leave_channel and can self-destruct a solo room)
    if (!id) {
      channelStore?.disconnect();
      channelStore = null;
      return;
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return;
    // Joiner nickname gate: per-room nick required, explicit confirm
    if (id && !selfNicks.has(id) && path.startsWith("/r/")) {
      joinPendingId = id;
      joinPendingKey = hk ?? roomKeyB64.get(id) ?? (keyInput.trim() && isRoomKeyB64(keyInput.trim()) ? keyInput.trim() : null);
      joinNick = "";
      joinError = null;
      queueMicrotask(() => navigate("/join"));
      return;
    }
    let cancelled = false;
    let store: ChannelStore | null = null;
    (async () => {
      try {
        if (!isCryptoAvailable()) throw new Error("E2EE requires HTTPS or localhost");
        const crypto = await getCryptoForChannel(id, hk);
        if (cancelled) return;
        const s = new ChannelStore(id, crypto, {
          onKeyRotated: (newKeyB64) => {
            roomKeyB64.set(id, newKeyB64);
            importRoomKey(newKeyB64)
              .then((k) => roomKeys.set(id, k))
              .catch(() => {});
          },
          onRoomNameUpdated: (name) => {
            roomNames.set(id, name);
            roomNamesVersion++;
          },
          onNicknameUpdated: (from, nick) => {
            peerNicks.set(`${id}:${from}`, nick);
            peerNicksVersion++;
            if (from === "self") selfNicks.set(id, nick);
          },
        });
        store = s;
        channelStore = s;
        s.connect();
        // after connect, broadcast our nick if we have one for this room (per-room) — dedup via lastBroadcastNick to avoid double with online-effect
        const selfNick = selfNicks.get(id);
        if (selfNick && isValidNick(selfNick) && selfNick !== lastBroadcastNick) {
          lastBroadcastNick = selfNick;
          setTimeout(async () => {
            try {
              const k = roomKeys.get(id);
              if (!k) return;
              const c = createAesGcmCrypto(k, id);
              const wrapped = await wrapNick(c, selfNick);
              await s.sendSetNickname(wrapped);
            } catch { lastBroadcastNick = null; }
          }, 500);
        }
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

  // re-broadcast display names when peers join (so new members learn existing names) — plain var to avoid $effect loop
  let lastOnlineForSync = 0;
  let lastBroadcastNick: string | null = null;
  let lastBroadcastRoomName: string | null = null;
  $effect(() => {
    const online = channelStore?.online ?? 0;
    const id = channelId;
    if (!id || !channelStore) { lastOnlineForSync = online; return; }
    if (online <= lastOnlineForSync) { lastOnlineForSync = online; return; }
    lastOnlineForSync = online;
    // a newly joined member cannot know our names (and neither can a fresh
    // reconnect) — re-announce despite lastBroadcast* dedup
    lastBroadcastNick = null;
    lastBroadcastRoomName = null;
    const nick = selfNicks.get(id);
    if (nick && isValidNick(nick) && nick !== lastBroadcastNick) {
      const k = roomKeys.get(id);
      if (k) {
        lastBroadcastNick = nick;
        wrapNick(createAesGcmCrypto(k, id), nick).then(w => channelStore?.sendSetNickname(w)).catch(()=>{ lastBroadcastNick = null; });
      }
    }
    const rname = roomNames.get(id);
    if (rname && isValidRoomName(rname) && rname !== lastBroadcastRoomName) {
      const k2 = roomKeys.get(id);
      if (k2) {
        lastBroadcastRoomName = rname;
        wrapRoomName(createAesGcmCrypto(k2, id), rname).then(w => channelStore?.sendSetRoomName(w)).catch(()=>{ lastBroadcastRoomName = null; });
      }
    }
  });

  async function handleSend() {
    if (!channelStore || !input.trim()) return;
    const ok = await channelStore.sendMessage(input);
    if (ok) input = "";
  }

  async function handleCreateRoom() {
    if (creating) return;
    if (!createRoomName.trim() || !isValidRoomName(createRoomName)) {
      createError = "Room name 1-32 chars, no newline";
      return;
    }
    if (!createNick.trim() || !isValidNick(createNick)) {
      createError = "Nickname 1-20 chars, no newline";
      return;
    }
    creating = true;
    createError = null;
    try {
      if (!isCryptoAvailable()) throw new Error("Web Crypto unavailable");
      const tmpKey = await generateRoomKey();
      const keyB64 = await exportRoomKey(tmpKey);
      const key = await importRoomKey(keyB64);
      const id = await createChannel();
      roomKeys.set(id, key);
      roomKeyB64.set(id, keyB64);
      roomNames.set(id, createRoomName.trim());
      roomNamesVersion++;
      selfNicks.set(id, createNick.trim());
      peerNicks.set(`${id}:self`, createNick.trim());
      peerNicksVersion++;
      navigate(`/r/${id}`);
      createRoomName = "";
      createNick = "";
    } catch (e) {
      createError = e instanceof Error ? e.message : String(e);
    } finally {
      creating = false;
    }
  }

  async function updateRoomName() {
    if (!channelId || !channelStore) return;
    const name = roomNameDraft.trim();
    if (!isValidRoomName(name)) {
      keyError = "Room name 1-32 chars";
      return;
    }
    try {
      const k = roomKeys.get(channelId);
      if (!k) throw new Error("no key");
      const crypto = createAesGcmCrypto(k, channelId);
      const wrapped = await wrapRoomName(crypto, name);
      const ok = await channelStore.sendSetRoomName(wrapped);
      if (!ok) throw new Error("not connected");
      roomNames.set(channelId, name);
      roomNamesVersion++;
      editingRoomName = false;
    } catch (e) {
      keyError = e instanceof Error ? e.message : String(e);
    }
  }

  async function updateNick() {
    if (!channelId || !channelStore) return;
    const nick = nickDraft.trim();
    if (!isValidNick(nick)) {
      keyError = "Nick 1-20 chars";
      return;
    }
    try {
      const k = roomKeys.get(channelId);
      if (!k) throw new Error("no key");
      const crypto = createAesGcmCrypto(k, channelId);
      const wrapped = await wrapNick(crypto, nick);
      const ok = await channelStore.sendSetNickname(wrapped);
      if (!ok) throw new Error("not connected");
      selfNicks.set(channelId, nick);
      // also update peerNicks for self for immediate display
      peerNicks.set(`${channelId}:self`, nick);
      peerNicksVersion++;
      editingNick = false;
    } catch (e) {
      keyError = e instanceof Error ? e.message : String(e);
    }
  }
  async function joinRoom() {
    const { id, key } = parseInvite(joinInput);
    if (isRoomKeyB64(id)) {
      alert(
        "This looks like a room key, not an invite link. Paste the full invite link (/r/<id>#k=...) or open the room first and paste the key there."
      );
      return;
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      alert("Invalid room id. Use 1-64 chars: a-z, A-Z, 0-9, _ -");
      return;
    }
    const k = key ?? (keyInput.trim() || null);
    if (k) {
      try {
        roomKeys.set(id, await importRoomKey(k));
      } catch {
        alert("Invalid room key in invite link. Expect 43 chars base64url.");
        return;
      }
      roomKeyB64.set(id, k);
    } else if (!roomKeys.has(id)) {
      // No key available — still go to nick gate, will prompt for key after
    }
    // per-room nickname required — go to intercept page before actually joining
    joinPendingId = id;
    joinPendingKey = k ?? roomKeyB64.get(id) ?? null;
    joinNick = selfNicks.get(id) ?? "";
    joinError = null;
    joinInput = "";
    drawerOpen = false;
    navigate("/join");
  }

  async function handleJoinConfirm() {
    if (!joinPendingId) return;
    const nick = joinNick.trim();
    if (!isValidNick(nick)) {
      joinError = "Nickname 1-20 chars, no newline (required)";
      return;
    }
    joinCreating = true;
    joinError = null;
    try {
      const id = joinPendingId!;
      // ensure key is available (already set in joinRoom, or from pending)
      if (!roomKeys.has(id) && joinPendingKey) {
        roomKeys.set(id, await importRoomKey(joinPendingKey));
        roomKeyB64.set(id, joinPendingKey);
      }
      if (!roomKeys.has(id)) throw new Error("missing room key — paste key from invite link");
      selfNicks.set(id, nick);
      peerNicks.set(`${id}:self`, nick);
      peerNicksVersion++;
      const pendingId = joinPendingId;
      joinPendingId = null;
      joinPendingKey = null;
      joinNick = "";
      navigate(`/r/${pendingId}`);
    } catch (e) {
      joinError = e instanceof Error ? e.message : String(e);
    } finally {
      joinCreating = false;
    }
  }

  function cancelJoin() {
    joinPendingId = null;
    joinPendingKey = null;
    joinNick = "";
    joinError = null;
    navigate("/");
  }
  function leaveRoom() {
    if (channelId) {
      roomKeys.delete(channelId);
      roomKeyB64.delete(channelId);
      roomNames.delete(channelId);
      selfNicks.delete(channelId);
      // clean peer nicks for this room
      for (const k of [...peerNicks.keys()]) if (k.startsWith(`${channelId}:`)) peerNicks.delete(k);
      roomHistory = roomHistory.filter((r) => r.id !== channelId);
    }
    keyInput = "";
    editingRoomName = false;
    editingNick = false;
    drawerOpen = false;
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
      roomKeyB64.set(channelId, b64);
      // clear a stale/invalid hash key (if any) so the effect re-run resolves via roomKeys
      pendingHashKey = null;
      history.replaceState({}, "", location.pathname);
      keyInput = "";
    } catch (e) {
      keyError = e instanceof Error ? e.message : String(e);
    }
  }
  function copyInviteLink() {
    // rebuild the invite link from the in-memory key when the URL no longer
    // carries it; without a key the joiner lands on the paste-key panel
    const b64 = channelId ? roomKeyB64.get(channelId) : undefined;
    const link = b64
      ? `${location.origin}/r/${channelId}#k=${encodeURIComponent(b64)}`
      : location.href;
    navigator.clipboard.writeText(link);
  }

  async function rotateKeyViaE2EE() {
    if (!channelId || !channelStore || rotating) return;
    rotating = true;
    keyError = null;
    try {
      const oldB64 = roomKeyB64.get(channelId);
      const oldKey = roomKeys.get(channelId);
      if (!oldB64 || !oldKey) throw new Error("no current key");
      const oldCrypto = createAesGcmCrypto(oldKey, channelId);
      const tmpKey = await generateRoomKey();
      const newB64 = await exportRoomKey(tmpKey);
      const newKey = await importRoomKey(newB64);
      const wrapped = await wrapNewKey(oldCrypto, newB64);
      const ok = await channelStore.sendKeyUpdate(wrapped);
      if (!ok) throw new Error("not connected");
      // optimistic local update
      roomKeys.set(channelId, newKey);
      roomKeyB64.set(channelId, newB64);
      channelStore.updateCrypto(createAesGcmCrypto(newKey, channelId));
      // auto-copy new invite
      const link = `${location.origin}/r/${channelId}#k=${encodeURIComponent(newB64)}`;
      await navigator.clipboard.writeText(link).catch(() => {});
    } catch (e) {
      keyError = e instanceof Error ? e.message : String(e);
    } finally {
      rotating = false;
    }
  }

  async function rotateKeyLocally() {
    //协作式移除: 本地轮换，不通过 E2EE 通道分享，旧成员不获新钥，需私下重分享新 invite 给保留成员
    if (!channelId || !channelStore || rotating) return;
    rotating = true;
    keyError = null;
    try {
      const tmpKey = await generateRoomKey();
      const newB64 = await exportRoomKey(tmpKey);
      const newKey = await importRoomKey(newB64);
      roomKeys.set(channelId, newKey);
      roomKeyB64.set(channelId, newB64);
      channelStore.updateCrypto(createAesGcmCrypto(newKey, channelId));
      const link = `${location.origin}/r/${channelId}#k=${encodeURIComponent(newB64)}`;
      await navigator.clipboard.writeText(link).catch(() => {});
      if (channelStore) {
        // system hint
        const ts = Date.now();
        channelStore.messages = [
          ...channelStore.messages,
          {
            channelId,
            payload: "🔑 Key rotated locally — share new invite only with members to keep (old members excluded)",
            from: "system",
            self: true,
            ts,
          } as unknown as ChatMessage,
        ];
      }
    } catch (e) {
      keyError = e instanceof Error ? e.message : String(e);
    } finally {
      rotating = false;
    }
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
    navigate(`/r/${id}`);
  }
</script>

<div class="flex h-screen bg-surface-subtle font-sans text-zinc-900 antialiased">
  {#if drawerOpen}
    <button class="fixed inset-0 z-20 bg-black/30 lg:hidden" aria-label="Close menu" onclick={() => (drawerOpen = false)}></button>
  {/if}
  <div class="fixed inset-y-0 left-0 z-30 w-64 transform bg-surface transition-transform lg:static lg:translate-x-0 {drawerOpen ? 'translate-x-0' : '-translate-x-full'}">
    <Sidebar
      rooms={sidebarRooms}
      roomNames={roomNames}
      activeId={channelId}
      {creating}
      bind:joinInput
      onCreate={() => { drawerOpen = false; navigate('/create'); }}
      onJoin={joinRoom}
      onNavigate={(id) => { drawerOpen = false; navigateToRoom(id); }}
    />
  </div>

  <main class="flex min-w-0 flex-1 flex-col bg-surface">
    {#if path === "/create"}
      <CreateRoomView
        bind:roomName={createRoomName}
        bind:nick={createNick}
        {creating}
        error={createError}
        onCreate={handleCreateRoom}
        onCancel={() => navigate("/")}
      />
    {:else if path === "/join"}
      {#if joinPendingId}
        <JoinNickView
          roomNamePreview={roomNames.get(joinPendingId) ?? `Room: ${shortId(joinPendingId)}`}
          bind:nick={joinNick}
          creating={joinCreating}
          error={joinError}
          onConfirm={handleJoinConfirm}
          onCancel={cancelJoin}
        />
      {:else}
        <div class="flex flex-1 items-center justify-center p-8">
          <div class="max-w-md text-center">
            <p class="text-sm text-zinc-500">No pending join. Paste an invite link via Sidebar.</p>
            <button class="mt-4 rounded-lg bg-brand px-4 py-2 text-sm text-white" onclick={() => navigate("/")}>Go home</button>
          </div>
        </div>
      {/if}
    {:else if path === "/"}
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
            class="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-700 hover:bg-zinc-100 lg:hidden"
            title="Open menu"
            aria-label="Open menu"
            onclick={() => (drawerOpen = true)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
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
          {#if editingRoomName}
            <input
              class="h-8 w-40 sm:w-56 rounded-lg border border-zinc-200 bg-surface px-2 text-sm outline-none focus:border-brand"
              placeholder="Room name 1-32"
              bind:value={roomNameDraft}
              maxlength={32}
              onkeydown={(e) => e.key === 'Enter' && updateRoomName()}
            />
            <button class="rounded-lg bg-brand px-2 py-1 text-xs text-white" onclick={updateRoomName}>Save</button>
            <button class="rounded-lg bg-zinc-100 px-2 py-1 text-xs" onclick={() => (editingRoomName = false)}>Cancel</button>
          {:else}
            <span class="text-lg font-bold tracking-tight truncate max-w-[12rem] sm:max-w-xs" title={roomNames.get(channelId) ?? channelId}>{roomNames.get(channelId) ?? `Room: ${shortId(channelId)}`}</span>
            {#if channelStore}
              <button class="text-xs text-zinc-400 hover:text-zinc-600" title="Edit room name" onclick={() => { roomNameDraft = roomNames.get(channelId) ?? ""; editingRoomName = true; }}>✎</button>
            {/if}
          {/if}
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
          {#if channelStore}
            <button
              class="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
              disabled={rotating || channelStore.status !== "open"}
              title="Generate new key and share via E2EE (all members get new key)"
              onclick={rotateKeyViaE2EE}
            >
              {rotating ? "Rotating…" : "Rotate & share"}
            </button>
            <button
              class="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50"
              disabled={rotating || channelStore.status !== "open"}
              title="Rotate locally only — old members won't get new key (cooperative eviction)"
              onclick={rotateKeyLocally}
            >
              Rotate locally
            </button>
          {/if}
        </div>
      </div>

      {#if channelStore}
        <div class="flex items-center gap-2 border-b border-zinc-100 bg-zinc-50 px-5 py-2 text-xs">
          {#if editingNick}
            <input
              class="h-7 rounded-lg border border-zinc-200 bg-surface px-2 text-xs outline-none focus:border-brand"
              placeholder="Nickname 1-20"
              bind:value={nickDraft}
              maxlength={20}
              onkeydown={(e) => e.key === 'Enter' && updateNick()}
            />
            <button class="rounded-lg bg-brand px-2 py-1 text-xs text-white" onclick={updateNick}>Save</button>
            <button class="rounded-lg bg-zinc-100 px-2 py-1 text-xs" onclick={() => (editingNick = false)}>Cancel</button>
          {:else}
            <span class="text-zinc-600">You as <span class="font-medium text-zinc-900">{selfNicks.get(channelId) ?? "Anonymous"}</span></span>
            <button class="text-zinc-400 hover:text-zinc-600" title="Edit nickname" onclick={() => { nickDraft = selfNicks.get(channelId) ?? ""; editingNick = true; }}>✎</button>
          {/if}
          <span class="ml-auto hidden sm:inline text-[11px] text-zinc-400">per-room · E2EE synced · tab memory</span>
        </div>
      {/if}
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
            This room is E2EE. Paste the base64url key from the invite link (#k=...). Key never
            leaves your device and is not persisted — paste it again after a refresh.
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
        <div bind:this={messagesEl} class="min-h-0 flex-1 overflow-y-auto bg-surface">
          <div class="mx-auto w-full max-w-3xl px-5 py-6">
            {#if channelStore.messages.length === 0}
              <div class="flex gap-3">
                <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-bold text-white">S</div>
                <div>
                  <div class="mb-1 text-sm font-medium text-zinc-700">System</div>
                  <div class="inline-block max-w-[min(70%,36rem)] rounded-2xl rounded-tl-md bg-zinc-100 px-4 py-2.5 text-sm">
                    🔒 您身处私密聊天室。消息采用端到端加密，仅限本聊天室的参与者查看，通过链接邀请他人加入。
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
                peerNicks={peerNicks}
                selfNicks={selfNicks}
                roomId={channelId}
                peerNicksVersion={peerNicksVersion}
                onCopy={copyText}
                onDelete={deleteMessage}
              />
            {/if}
          </div>
        </div>

        <!-- Composer -->
        <div class="shrink-0 border-t border-zinc-200">
          <div class="mx-auto w-full max-w-3xl">
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
        </div>
      {/if}
    {:else}
      <div class="flex flex-1 items-center justify-center p-8">
        <p class="text-sm text-zinc-500">Not found</p>
      </div>
    {/if}
  </main>
</div>
