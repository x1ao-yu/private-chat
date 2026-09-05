<script lang="ts">
  let {
    roomNamePreview = "",
    nick = $bindable(""),
    creating = false,
    error = null as string | null,
    onConfirm,
    onCancel,
  }: {
    roomNamePreview: string;
    nick: string;
    creating: boolean;
    error: string | null;
    onConfirm: () => void;
    onCancel: () => void;
  } = $props();
</script>

<div class="flex flex-1 items-center justify-center p-8">
  <div class="w-full max-w-md rounded-2xl border border-zinc-200 bg-surface p-6 shadow-sm">
    <h2 class="text-lg font-bold tracking-tight">Join Room</h2>
    <p class="mt-1 text-xs text-zinc-500">Set your nickname for this room. Messages are signed with this session's identity (Ed25519, tab memory only — not a permanent identity).</p>
    <div class="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3">
      <div class="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Room</div>
      <div class="mt-1 truncate text-sm font-semibold text-zinc-900" title={roomNamePreview}>{roomNamePreview}</div>
    </div>
    <div class="mt-5 space-y-4">
      <label class="block">
        <span class="text-xs font-medium text-zinc-700">Your nickname (1-20, required)</span>
        <input
          class="mt-1.5 h-9 w-full rounded-lg border border-zinc-200 bg-surface px-3 text-sm outline-none focus:border-brand"
          placeholder="e.g. Bob"
          bind:value={nick}
          maxlength={20}
          onkeydown={(e) => e.key === "Enter" && onConfirm()}
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
          onclick={onConfirm}
          disabled={creating || !nick.trim()}
        >
          {creating ? "Joining..." : "Confirm & Join"}
        </button>
      </div>
      <p class="text-center text-[11px] text-zinc-400">nickname E2EE synced after join · signed with this session's identity · not persisted</p>
    </div>
  </div>
</div>
