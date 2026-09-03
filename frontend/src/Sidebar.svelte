<script lang="ts">
  export type RoomEntry = {
    id: string;
    online: number;
    connected: boolean;
  };

  let {
    rooms = [],
    roomNames = new Map<string, string>(),
    activeId = "",
    creating = false,
    joinInput = $bindable(""),
    onCreate,
    onJoin,
    onNavigate,
  }: {
    rooms?: RoomEntry[];
    roomNames?: Map<string, string>;
    activeId?: string;
    creating?: boolean;
    joinInput?: string;
    onCreate: () => void;
    onJoin: (id: string) => void;
    onNavigate: (id: string) => void;
  } = $props();

  function submitJoin() {
    const id = joinInput.trim();
    if (!id) return;
    onJoin(id);
  }
</script>

<aside class="flex h-full w-64 shrink-0 flex-col border-r border-zinc-200 bg-surface">
  <!-- Brand -->
  <div class="flex items-center gap-3 border-b border-zinc-200 p-4">
    <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-white">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
        <rect x="4" y="11" width="16" height="9" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
    </div>
    <span class="text-sm font-bold tracking-tight">Private Chat</span>
  </div>

  <!-- Create -->
  <div class="p-4">
    <button
      class="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
      onclick={onCreate}
      disabled={creating}
    >
      {creating ? "Creating..." : "Create Room"}
    </button>
  </div>

  <!-- Join -->
  <div class="px-4 pb-4">
    <div class="mb-1.5 text-xs font-medium text-zinc-500">Join Room</div>
    <div class="flex gap-2">
      <input
        class="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none placeholder:text-zinc-400 focus:border-brand focus:bg-surface"
        placeholder="Room ID or Invite Link"
        bind:value={joinInput}
        onkeydown={(e) => e.key === "Enter" && submitJoin()}
      />
      <button
        class="rounded-lg bg-brand px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover"
        onclick={submitJoin}
      >
        Join
      </button>
    </div>
  </div>

  <!-- Room list -->
  <div class="min-h-0 flex-1 overflow-y-auto p-2">
    {#each rooms as room (room.id)}
      {@const displayName = roomNames.get(room.id) ?? `Room: ${room.id}`}
      <button
        class="w-full rounded-lg px-3 py-2.5 text-left transition-colors {room.id === activeId ? 'bg-brand-subtle' : 'hover:bg-zinc-100'}"
        onclick={() => onNavigate(room.id)}
        title={roomNames.get(room.id) ? `${roomNames.get(room.id)} (${room.id})` : room.id}
      >
        <div class="truncate text-sm font-semibold {room.id === activeId ? 'text-brand' : 'text-zinc-800'}">
          {displayName}
        </div>
        <div class="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500">
          {#if room.connected}
            <span class="h-1.5 w-1.5 rounded-full bg-ok"></span>
            {room.online} online
          {:else}
            <span class="h-1.5 w-1.5 rounded-full bg-zinc-300"></span>
            Offline
          {/if}
        </div>
      </button>
    {/each}
  </div>

  <!-- Settings -->
  <div class="border-t border-zinc-200 p-3">
    <button class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-100">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
      Settings
    </button>
  </div>
</aside>
