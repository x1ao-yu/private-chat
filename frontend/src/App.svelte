<script lang="ts">
  import { ChannelStore, createChannel } from "./channel.svelte.ts";

  let path = $state(window.location.pathname);
  let channelStore: ChannelStore | null = $state(null);
  let input = $state("");
  let joinInput = $state("");
  let creating = $state(false);
  let createError: string | null = $state(null);
  let messagesEl: HTMLDivElement | null = $state(null);

  function navigate(to: string) {
    history.pushState({}, "", to);
    path = to;
  }

  window.addEventListener("popstate", () => {
    path = window.location.pathname;
  });

  let channelId = $derived(path.startsWith("/r/") ? path.slice(3).split("/")[0].split("?")[0] : "");

  // reactively manage ChannelStore lifecycle
  $effect(() => {
    const id = channelId;
    if (!id) {
      channelStore?.disconnect();
      channelStore = null;
      return;
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      return;
    }
    const store = new ChannelStore(id);
    channelStore = store;
    store.connect();
    return () => {
      store.disconnect();
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
      const id = await createChannel();
      navigate(`/r/${id}`);
    } catch (e) {
      createError = e instanceof Error ? e.message : String(e);
      // fallback: local random for offline dev
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
    navigate(`/r/${id}`);
  }

  function leaveRoom() {
    channelStore?.disconnect();
    navigate("/");
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
          <p class="mt-1 text-sm text-zinc-500">Creates on server (create_channel). Share the link to invite.</p>
          <button
            class="mt-4 rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            onclick={createRoom}
            disabled={creating}
          >
            {creating ? "Creating..." : "Create room"}
          </button>
          {#if createError}
            <p class="mt-2 text-xs text-amber-600">Create failed, used fallback: {createError}</p>
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
          <p class="mt-2 text-xs text-zinc-400">Join strictly checks existence (channel_not_found if missing).</p>
        </div>

        <p class="text-xs text-zinc-400">P1: message relay + reconnect + online count. WS at {`{host}/ws`}.</p>
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

      {#if channelStore?.error}
        <div class="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{channelStore.error}</div>
      {/if}

      {#if !/^[a-zA-Z0-9_-]{1,64}$/.test(channelId)}
        <div class="mt-6 rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Invalid room id. Use 1-64 chars: a-z, A-Z, 0-9, _ -
        </div>
      {:else}
        <div bind:this={messagesEl} class="mt-3 flex-1 overflow-y-auto rounded border bg-zinc-50 p-3">
          {#if channelStore && channelStore.messages.length === 0}
            <p class="text-sm text-zinc-400">No messages yet. Invite someone with the link.</p>
            <p class="mt-2 text-xs text-zinc-400">Status: {channelStore?.status} · {channelStore?.online} online</p>
            {#if channelStore?.status === "reconnecting"}
              <p class="mt-1 text-xs text-amber-600">Reconnecting... (up to 10s backoff)</p>
            {/if}
            {#if channelStore?.error?.includes("channel_not_found")}
              <p class="mt-2 text-xs text-red-600">Room not found. Ask creator to create it via Create.</p>
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
            placeholder="Type a message"
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
          P1: plaintext relay · WS lifecycle + Ping/Pong heartbeat authoritative leave · auto-reconnect 10s jitter
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
