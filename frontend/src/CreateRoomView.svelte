<script lang="ts">
  let {
    roomName = $bindable(""),
    nick = $bindable(""),
    creating = false,
    error = null as string | null,
    onCreate,
    onCancel,
  }: {
    roomName: string;
    nick: string;
    creating: boolean;
    error: string | null;
    onCreate: () => void;
    onCancel: () => void;
  } = $props();

  function submit() {
    if (!creating) onCreate();
  }
</script>

<div class="flex flex-1 items-center justify-center p-8">
  <div class="w-full max-w-md rounded-2xl border border-zinc-200 bg-surface p-6 shadow-sm">
    <h2 class="text-lg font-bold tracking-tight">Create Room</h2>
    <p class="mt-1 text-xs text-zinc-500">Rooms are E2EE. Names / nicknames are display only (not identity). Stored in memory, lost on refresh — P4.</p>
    <div class="mt-5 space-y-4">
      <label class="block">
        <span class="text-xs font-medium text-zinc-700">Room name (1-32)</span>
        <input
          class="mt-1.5 h-9 w-full rounded-lg border border-zinc-200 bg-surface px-3 text-base outline-none focus:border-brand sm:text-sm"
          placeholder="e.g. Weekend plan"
          bind:value={roomName}
          maxlength={32}
          onkeydown={(e) => e.key === "Enter" && submit()}
        />
        <span class="mt-1 text-[11px] text-zinc-400">{roomName.trim().length}/32</span>
      </label>
      <label class="block">
        <span class="text-xs font-medium text-zinc-700">Your nickname (1-20)</span>
        <input
          class="mt-1.5 h-9 w-full rounded-lg border border-zinc-200 bg-surface px-3 text-base outline-none focus:border-brand sm:text-sm"
          placeholder="e.g. Alice"
          bind:value={nick}
          maxlength={20}
          onkeydown={(e) => e.key === "Enter" && submit()}
        />
        <span class="mt-1 text-[11px] text-zinc-400">{nick.trim().length}/20</span>
      </label>
      {#if error}
        <p class="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
      {/if}
      <div class="flex gap-2 pt-2">
        <button
          class="flex-1 rounded-lg border border-zinc-200 bg-surface px-4 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          onclick={onCancel}
          disabled={creating}
        >
          Cancel
        </button>
        <button
          class="flex-1 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50"
          onclick={submit}
          disabled={creating || !roomName.trim() || !nick.trim()}
        >
          {creating ? "Creating..." : "Create & Enter"}
        </button>
      </div>
      <p class="text-center text-[11px] text-zinc-400">tab memory only · not persisted · shared via E2EE if you update later</p>
    </div>
  </div>
</div>
