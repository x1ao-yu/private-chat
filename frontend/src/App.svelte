<script lang="ts">
  import { ChannelStore, createChannel } from "./channel.svelte.ts";
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

  const roomKeys = new Map<string, CryptoKey>();

  function navigate(to: string) {
    history.pushState({}, "", to);
    path = window.location.pathname;
    if (to.includes("#")) location.hash = to.slice(to.indexOf("#"));
  }
  window.addEventListener("popstate", () => (path = window.location.pathname));
  window.addEventListener("hashchange", () => (path = window.location.pathname));

  let channelId = $derived(path.startsWith("/r/") ? path.slice(3).split("/")[0].split("?")[0].split("#")[0] : "");
  let hashKey = $derived.by(() => {
    const h = location.hash;
    if (!h) return null;
    const m = h.match(/[#&]k=([^&]+)/) || h.match(/[#&]key=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  });

  function hashColor(str: string): string {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 70% 50%)`;
  }
  function avatarLetter(from: string): string {
    return from.slice(0, 2).toUpperCase();
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
      channelStore?.disconnect();
      channelStore = null;
    };
  });

  $effect(() => {
    if (channelStore?.messages.length && messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
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
  function joinRoom() {
    const id = joinInput.trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      alert("Invalid room id. Use 1-64 chars: a-z, A-Z, 0-9, _ -");
      return;
    }
    if (keyInput.trim()) navigate(`/r/${id}#k=${encodeURIComponent(keyInput.trim())}`);
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
</script>

<main class="min-h-screen bg-[#fafafa] text-zinc-900 antialiased">
  {#if path === "/"}
    <div class="mx-auto max-w-2xl px-6 py-12">
      <div class="text-center">
        <h1 class="text-4xl font-bold tracking-tight">Private Chat</h1>
        <p class="mt-3 text-zinc-600">No account · No contacts · Rooms only · E2EE in browser</p>
      </div>
      <div class="mt-10 grid gap-6">
        <div class="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 class="font-semibold">Create a room</h2>
          <p class="mt-1 text-sm text-zinc-500">Server creates empty room, key stays in hash #k= (never sent to server) · AES-GCM-256</p>
          <button class="mt-4 rounded-full bg-zinc-900 px-6 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50" onclick={createRoom} disabled={creating || !isCryptoAvailable()}>
            {creating ? "Creating..." : "Create E2EE room"}
          </button>
          {#if createError}<p class="mt-2 text-xs text-red-600">{createError}</p>{/if}
          {#if !isCryptoAvailable()}<p class="mt-2 text-xs text-red-600">Web Crypto unavailable — need HTTPS or localhost (no downgrade)</p>{/if}
        </div>
        <div class="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 class="font-semibold">Join a room</h2>
          <p class="mt-1 text-sm text-zinc-500">Paste full invite link or room id + key separately</p>
          <div class="mt-4 flex gap-2">
            <input class="flex-1 rounded-full border bg-zinc-50 px-4 py-3 text-sm outline-none focus:border-zinc-900 focus:bg-white" placeholder="room id or full invite link" bind:value={joinInput} onkeydown={(e)=>e.key==="Enter"&&joinRoom()} />
            <button class="rounded-full bg-zinc-900 px-6 py-3 text-sm font-medium text-white hover:bg-zinc-800" onclick={joinRoom}>Join</button>
          </div>
          <div class="mt-3">
            <input class="w-full rounded-full border bg-zinc-50 px-4 py-2.5 text-xs outline-none focus:border-zinc-900 focus:bg-white" placeholder="paste room key (base64url) if not in link" bind:value={keyInput} />
          </div>
        </div>
      </div>
      <p class="mt-8 text-center text-xs text-zinc-400">E2EE · 12B IV + 16B messageId per message · AAD v1|channelId|messageId · server sees ciphertext only</p>
    </div>
  {:else if path.startsWith("/r/")}
    <div class="mx-auto flex h-screen max-w-3xl flex-col bg-white">
      <!-- Header -->
      <div class="flex h-14 items-center justify-between border-b px-4">
        <button class="flex items-center gap-2 text-sm text-zinc-600 hover:text-zinc-900" onclick={leaveRoom}>
          <span class="flex h-7 w-7 items-center justify-center rounded-full border">←</span> Leave
        </button>
        <div class="flex items-center gap-3">
          <span class="text-sm font-medium">Room: {channelId}</span>
          {#if channelStore}
            <span class="flex items-center gap-2 rounded-full bg-zinc-100 px-3 py-1 text-xs">
              <span class="h-2 w-2 rounded-full {channelStore.status==='open' ? 'bg-green-500' : channelStore.status==='reconnecting' ? 'bg-amber-500' : 'bg-zinc-400'}"></span>
              {channelStore.status} · {channelStore.online} online
            </span>
          {:else}
            <span class="rounded-full bg-amber-100 px-3 py-1 text-xs">need key</span>
          {/if}
        </div>
        <button class="rounded-full border px-4 py-1.5 text-xs hover:bg-zinc-50" onclick={copyInviteLink}>Copy invite link</button>
      </div>

      {#if keyError}<div class="mx-4 mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-700">{keyError}</div>{/if}
      {#if channelStore?.error}<div class="mx-4 mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{channelStore.error}</div>{/if}
      {#if !isCryptoAvailable()}<div class="mx-4 mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">Web Crypto unavailable — messages blocked</div>{/if}

      {#if !/^[a-zA-Z0-9_-]{1,64}$/.test(channelId)}
        <div class="mx-4 mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">Invalid room id</div>
      {:else if !channelStore}
        <div class="mx-4 mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <p class="text-sm font-medium">Enter room key to decrypt</p>
          <p class="text-xs text-zinc-600 mt-1">This room is E2EE. Paste the base64url key from invite link. Key never leaves your device.</p>
          <div class="mt-3 flex gap-2">
            <input class="flex-1 rounded-full border bg-white px-4 py-2.5 text-xs" placeholder="paste key 43 chars" bind:value={keyInput} />
            <button class="rounded-full bg-zinc-900 px-5 py-2.5 text-xs font-medium text-white" onclick={importPastedKey}>Use key</button>
          </div>
          {#if keyError}<p class="mt-2 text-xs text-red-600">{keyError}</p>{/if}
        </div>
        <div class="mx-4 mt-4 flex-1 rounded-2xl border bg-zinc-50 p-6 text-sm text-zinc-400">Waiting for correct key…</div>
      {:else}
        <!-- Messages -->
        <div bind:this={messagesEl} class="flex-1 overflow-y-auto px-4 py-6">
          {#if channelStore.messages.length === 0}
            <div class="flex gap-3">
              <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-xs font-bold text-white">S</div>
              <div>
                <div class="text-sm font-medium">System</div>
                <div class="mt-1 max-w-[75%] rounded-2xl bg-zinc-100 px-4 py-3 text-sm">Hello, I'm your private room. Invite someone with the link (key in hash never leaves your device).</div>
                <div class="mt-2 text-xs text-zinc-400">Status: {channelStore.status} · {channelStore.online} online {#if channelStore.status==='reconnecting'}· Reconnecting up to 10s{/if}</div>
              </div>
            </div>
          {:else}
            <div class="space-y-6">
              {#each channelStore.messages as m, i (i)}
                {#if m.self}
                  <!-- User (self) right -->
                  <div class="flex justify-end gap-3">
                    <div class="flex max-w-[75%] flex-col items-end">
                      <div class="mb-1 flex items-center gap-2 text-xs text-zinc-500">User <span class="h-6 w-6 rounded-full flex items-center justify-center text-[10px] text-white" style="background:{hashColor(m.from)}">{avatarLetter(m.from)}</span></div>
                      <div class="rounded-2xl bg-blue-600 px-4 py-3 text-sm text-white shadow-sm">{m.payload}</div>
                      <div class="mt-1 flex gap-2 opacity-0 group-hover:opacity-100">
                        <button class="text-xs text-zinc-400 hover:text-zinc-600" onclick={()=>copyText(m.payload)}>Copy</button>
                        <button class="text-xs text-zinc-400 hover:text-red-600" onclick={()=>deleteMessage(i)}>Delete</button>
                      </div>
                    </div>
                  </div>
                {:else}
                  <!-- Assistant (other) left -->
                  <div class="group flex gap-3">
                    <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white" style="background:{hashColor(m.from)}">{avatarLetter(m.from)}</div>
                    <div class="max-w-[75%]">
                      <div class="text-sm font-medium">Assistant <span class="text-xs text-zinc-400">{m.from}</span></div>
                      <div class="mt-1 rounded-2xl bg-zinc-100 px-4 py-3 text-sm">{m.payload}</div>
                      <div class="mt-2 flex gap-3 text-zinc-400 opacity-60 group-hover:opacity-100">
                        <button class="hover:text-zinc-700" title="Copy" onclick={()=>copyText(m.payload)}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3"/></svg>
                        </button>
                        <button class="hover:text-red-600" title="Delete (local)" onclick={()=>deleteMessage(i)}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                        </button>
                      </div>
                    </div>
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>

        <!-- Composer -->
        <div class="border-t bg-white p-4">
          <div class="flex items-end gap-3">
            <button class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border hover:bg-zinc-50" title="Clear local chat (trash)" onclick={clearLocalMessages}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
            <div class="flex flex-1 items-end gap-2 rounded-3xl border bg-zinc-50 px-3 py-2 focus-within:bg-white focus-within:border-zinc-900">
              <button class="mb-1 text-zinc-500 hover:text-zinc-700" title="Copy invite link" onclick={copyInviteLink}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              </button>
              <textarea
                class="max-h-28 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-zinc-400"
                placeholder="Type a message (E2EE)..."
                rows="1"
                bind:value={input}
                onkeydown={(e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); handleSend(); }}}
                disabled={!isCryptoAvailable()}
              ></textarea>
              <button class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full {input.trim() && channelStore.status==='open' ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-zinc-200 text-zinc-400'} " onclick={handleSend} disabled={!input.trim() || channelStore.status!=='open'}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
              </button>
            </div>
          </div>
          <p class="mt-2 text-center text-[11px] text-zinc-400">E2EE · 12B IV + 16B messageId · AAD v1|channelId|messageId · key in memory only · server sees ciphertext · {channelStore.status} · {channelStore.online} online</p>
        </div>
      {/if}
    </div>
  {:else}
    <div class="mx-auto max-w-xl p-8">
      <p>Not found</p>
      <button class="mt-2 text-sm underline" onclick={()=>navigate("/")}>Go home</button>
    </div>
  {/if}
</main>
