<script lang="ts">
  let {
    input = $bindable(""),
    disabled = false,
    canSend = false,
    onSend,
    onClear,
  }: {
    input?: string;
    disabled?: boolean;
    canSend?: boolean;
    onSend: () => void;
    onClear: () => void;
  } = $props();
</script>

<div class="flex items-center gap-3 p-4">
  <button
    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
    title="Clear local chat"
    aria-label="Clear local chat"
    onclick={onClear}
  >
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  </button>

  <input
    class="h-10 min-w-0 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-4 text-sm outline-none placeholder:text-zinc-400 focus:border-brand focus:bg-surface"
    placeholder="Message..."
    bind:value={input}
    onkeydown={(e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    }}
    disabled={disabled}
  />

  <button
    class="h-10 shrink-0 rounded-lg px-5 text-sm font-medium text-white transition-colors {canSend
      ? 'bg-brand hover:bg-brand-hover'
      : 'bg-zinc-300 text-zinc-500'}"
    onclick={onSend}
    disabled={!canSend}
  >
    Send
  </button>
</div>
