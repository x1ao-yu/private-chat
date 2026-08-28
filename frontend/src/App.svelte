<script lang="ts">
  import { ChannelStore, createChannel } from "./channel.svelte.ts";
  import {
    generateRoomKey,
    exportRoomKey,
    importRoomKey,
    createAesGcmCrypto,
    isCryptoAvailable,
    noopCrypto,
  } from "./e2ee.ts";
  import type { Crypto } from "./e2ee.ts";

  let path = $state(window.location.pathname);
  let channelStore: ChannelStore | null = $state(null);
  let input = $state("");
  let joinInput = $state("");
  let creating = $state(false);
  let createError: string | null = $state(null);
  let messagesEl: HTMLDivElement | null = $state(null);
  let keyInput = $state("");
  let keyError: string | null = $state(null);

  // in-memory per-room keys (ephemeral, not persisted)
  const roomKeys = new Map<string, CryptoKey>();

  function navigate(to: string) {
    history.pushState({}, "", to);
    path = window.location.pathname;
    // hash may have changed via to
    if (to.includes("#")) {
      // force hash update
      location.hash = to.slice(to.indexOf("#"));
    }
  }

  window.addEventListener("popstate", () => {
    path = window.location.pathname;
  });
  window.addEventListener("hashchange", () => {
    // trigger re-evaluation of channelId effect by touching path
    path = window.location.pathname;
  });

  let channelId = $derived(path.startsWith("/r/") ? path.slice(3).split("/")[0].split("?")[0].split("#")[0] : "");
  let hashKey = $derived.by(() => {
    const h = location.hash; // e.g. #k=abc or #key=abc
    if (!h) return null;
    const m = h.match(/[#&]k=([^&]+)/) || h.match(/[#&]key=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  });

  function getCryptoForChannel(id: string, hashB64: string | null): Promise<Crypto> {
    // 1. hash key (shared link)
    if (hashB64) {
      return importRoomKey(hashB64)
        .then((k) => {
          roomKeys.set(id, k);
          return createAesGcmCrypto(k, id);
        })
        .catch(() => {
          throw new Error("invalid key in link");
        });
    }
    // 2. in-memory (creator)
    const k = roomKeys.get(id);
    if (k) {
      return Promise.resolve(createAesGcmCrypto(k, id));
    }
    // 3. fallback: user pasted key via input
    if (keyInput.trim()) {
      return importRoomKey(keyInput.trim())
        .then((k2) => {
          roomKeys.set(id, k2);
          return createAesGcmCrypto(k2, id);
        })
        .catch(() => {
          throw new Error("invalid pasted key");
        });
    }
    // 4. no key: use noop (will fail decrypt, show error)
    return Promise.resolve(noopCrypto);
  }

  // reactively manage ChannelStore lifecycle
  $effect(() => {
    const id = channelId;
    const hk = hashKey;
    // also depend on keyInput for manual paste
    void keyInput;
    if (!id) {
      channelStore?.disconnect();
      channelStore = null;
      return;
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      return;
    }
    let cancelled = false;
    let store: ChannelStore | null = null;

    (async () => {
      try {
        if (!isCryptoAvailable()) {
          keyError = "E2EE requires HTTPS or localhost (Web Crypto unavailable)";
          const s = new ChannelStore(id, noopCrypto);
          if (cancelled) return;
          channelStore = s;
          s.connect();
          return;
        }
        const crypto = await getCryptoForChannel(id, hk);
        if (cancelled) return;
        // if we got key from hash but hash not in URL, update URL
        if (hk && !location.hash.includes(hk)) {
          // already has hash
        }
        const s = new ChannelStore(id, crypto);
        store = s;
        channelStore = s;
        s.connect();
        keyError = null;
      } catch (e) {
        keyError = e instanceof Error ? e.message : String(e);
        const s = new ChannelStore(id, noopCrypto);
        if (cancelled) return;
        channelStore = s;
        s.connect();
      }
    })();

    return () => {
      cancelled = true;
      store?.disconnect();
      channelStore?.disconnect();
      channelStore = null;
    };
  });

  // auto-scroll
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
      const key = await generateRoomKey();
      const keyB64 = await exportRoomKey(key);
      const id = await createChannel();
      roomKeys.set(id, key);
      navigate(`/r/${id}#k=${encodeURIComponent(keyB64)}`);
    } catch (e) {
      createError = e instanceof Error ? e.message : String(e);
      const fallback = crypto.randomUUID().slice(0, 8);
      navigate(`/r/${fallback}`);
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
    // if keyInput has key, append to hash
    if (keyInput.trim()) {
      navigate(`/r/${id}#k=${encodeURIComponent(keyInput.trim())}`);
    } else {
      navigate(`/r/${id}`);
    }
  }

  function leaveRoom() {
    channelStore?.disconnect();
    navigate("/");
  }

  async function importPastedKey() {
    keyError = null;
    try {
      const k = await importRoomKey(keyInput.trim());
      if (!channelId) throw new Error("no channel");
      roomKeys.set(channelId, k);
      // force re-create store by touching keyInput
      keyInput = keyInput.trim();
      // reload store
      channelStore?.disconnect();
      channelStore = null;
      // trigger effect via re-assigning path
      const hk = keyInput.trim();
      navigate(`/r/${channelId}#k=${encodeURIComponent(hk)}`);
    } catch (e) {
      keyError = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<main class="min-h-screen bg-white text-zinc-900 antialiased">
  {#if path === "/"}
    <div class="mx-auto max-w-xl p-8">
      <h1 class="text-3xl font-bold tracking-tight">Private Chat</h1>
      <p class="mt-2 text-zinc-600">Lightweight E2EE — Rooms only. No accounts.</p>

      <div class="mt-8 space-y-6">
        <div class="rounded-lg border p-6">
          <h2 class="font-semibold">Create a room</h2>
          <p class="mt-1 text-sm text-zinc-500">Generates server room + client-side AES-GCM-256 key. Share link with key in hash (never sent to server).</p>
          <button
            class="mt-4 rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            onclick={createRoom}
            disabled={creating}
          >
            {creating ? "Creating..." : "Create E2EE room"}
          </button>
          {#if createError}
            <p class="mt-2 text-xs text-amber-600">Create failed: {createError}</p>
          {/if}
          {#if !isCryptoAvailable()}
            <p class="mt-2 text-xs text-red-600">Web Crypto unavailable — need HTTPS or localhost</p>
          {/if}
        </div>

        <div class="rounded-lg border p-6">
          <h2 class="font-semibold">Join a room</h2>
          <div class="mt-3 flex gap-2">
            <input
              class="flex-1 rounded border px-3 py-2 text-sm outline-none focus:border-zinc-900"
              placeholder="room id"
              bind:value={joinInput}
              onkeydown={(e) => e.key === "Enter" && joinRoom()}
            />
            <button
              class="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
              onclick={joinRoom}
            >
              Join
            </button>
          </div>
          <div class="mt-3">
            <input
              class="w-full rounded border px-3 py-2 text-xs outline-none focus:border-zinc-900"
              placeholder="paste room key (base64url) if you have it"
              bind:value={keyInput}
            />
            <p class="mt-1 text-xs text-zinc-400">Key stays in memory, never sent to server. Leave `from` is per-connection.</p>
          </div>
        </div>

        <p class="text-xs text-zinc-400">P2: E2EE AES-GCM 12B IV + 16B messageId + AAD v1|channelId|messageId, server sees ciphertext only. WS at {`{host}/ws`}.</p>
      </div>
    </div>
  {:else if path.startsWith("/r/")}
    <div class="mx-auto flex h-screen max-w-xl flex-col p-4">
      <div class="flex items-center justify-between border-b pb-3">
        <button class="text-sm text-zinc-600 hover:text-zinc-900" onclick={leaveRoom}>
          ← Leave
        </button>
        <div class="text-sm">
          <span class="font-medium">Room:</span> {channelId}
          {#if channelStore}
            <span class="ml-2 rounded bg-zinc-100 px-2 py-0.5 text-xs">
              {channelStore.status}
              · {channelStore.online} online
            </span>
          {/if}
        </div>
        <button
          class="text-sm text-zinc-600 hover:text-zinc-900"
          onclick={() => {
            navigator.clipboard.writeText(location.href);
          }}
        >
          Copy link
        </button>
      </div>

      {#if keyError}
        <div class="mt-3 rounded bg-amber-50 p-2 text-sm text-amber-700">{keyError} — paste correct key below</div>
      {/if}
      {#if channelStore?.error}
        <div class="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{channelStore.error}</div>
      {/if}
      {#if !isCryptoAvailable()}
        <div class="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">Web Crypto unavailable — E2EE disabled</div>
      {/if}

      {#if !/^[a-zA-Z0-9_-]{1,64}$/.test(channelId)}
        <div class="mt-6 rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Invalid room id. Use 1-64 chars: a-z, A-Z, 0-9, _ -
        </div>
      {:else}
        {#if !hashKey && !roomKeys.has(channelId) && !keyInput}
          <div class="mt-3 rounded border border-amber-200 bg-amber-50 p-3">
            <p class="text-sm font-medium">Enter room key to decrypt</p>
            <p class="text-xs text-zinc-600">This room is E2EE. Paste the base64url key from the invite link (hash #k=...).</p>
            <div class="mt-2 flex gap-2">
              <input class="flex-1 rounded border px-3 py-2 text-xs" placeholder="paste key" bind:value={keyInput} />
              <button class="rounded bg-zinc-900 px-3 py-2 text-xs text-white" onclick={importPastedKey}>Use key</button>
            </div>
            {#if keyError}<p class="mt-1 text-xs text-red-600">{keyError}</p>{/if}
          </div>
        {/if}

        <div bind:this={messagesEl} class="mt-3 flex-1 overflow-y-auto rounded border bg-zinc-50 p-3">
          {#if channelStore && channelStore.messages.length === 0}
            <p class="text-sm text-zinc-400">No messages yet. Invite someone with the link (key in hash never leaves your device).</p>
            <p class="mt-2 text-xs text-zinc-400">Status: {channelStore?.status} · {channelStore?.online} online</p>
            {#if channelStore?.status === "reconnecting"}
              <p class="mt-1 text-xs text-amber-600">Reconnecting... (up to 10s backoff)</p>
            {/if}
            {#if channelStore?.error?.includes("decrypt failed")}
              <p class="mt-2 text-xs text-red-600">Decrypt failed — wrong key or corrupted. Check key.</p>
            {/if}
          {:else if channelStore}
            <ul class="space-y-2">
              {#each channelStore.messages as m, i (i)}
                <li class="rounded bg-white px-3 py-2 text-sm shadow-sm">
                  <span class="font-medium">{m.from}:</span> {m.payload}
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <div class="mt-3 flex gap-2">
          <input
            class="flex-1 rounded border px-3 py-2 text-sm outline-none focus:border-zinc-900"
            placeholder="Type a message (will be E2EE)"
            bind:value={input}
            onkeydown={(e) => e.key === "Enter" && handleSend()}
            disabled={!channelStore || (channelStore.status !== "open" && channelStore.status !== "reconnecting")}
          />
          <button
            class="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            onclick={handleSend}
            disabled={!channelStore || channelStore.status !== "open" || !input.trim()}
          >
            Send
          </button>
        </div>
        <p class="mt-2 text-xs text-zinc-400">
          E2EE: AES-GCM-256, 12B IV + 16B messageId per message, AAD v1|channelId|messageId, key in memory only, server sees ciphertext.
        </p>
      {/if}
    </div>
  {:else}
    <div class="mx-auto max-w-xl p-8">
      <p>Not found</p>
      <button class="mt-2 text-sm underline" onclick={() => navigate("/")}>Go home</button>
    </div>
  {/if}
</main>
