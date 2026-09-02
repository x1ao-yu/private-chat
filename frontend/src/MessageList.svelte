<script lang="ts">
  import type { ChatMessage } from "./channel.svelte.ts";

  let {
    messages,
    peerNicks = new Map<string, string>(),
    selfNicks = new Map<string, string>(),
    roomId = "",
    onCopy,
    onDelete,
  }: {
    messages: ChatMessage[];
    peerNicks?: Map<string, string>;
    selfNicks?: Map<string, string>;
    roomId?: string;
    onCopy: (text: string) => void;
    onDelete: (idx: number) => void;
  } = $props();

  function hashColor(str: string): string {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 65% 45%)`;
  }
  function avatarLetter(from: string): string {
    const base = from.replace(/^peer-/, "").slice(0, 1).toUpperCase() || "?";
    return base;
  }
  function displayNick(m: ChatMessage): string {
    if (m.from === "system") return "System";
    if (m.self) return selfNicks.get(roomId) ?? "You";
    return peerNicks.get(`${roomId}:${m.from}`) ?? m.from;
  }
  function avatarSrc(m: ChatMessage): string {
    const nick = displayNick(m);
    return avatarLetter(nick === m.from ? m.from : nick);
  }
  function fmtTime(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
</script>

<div class="space-y-5">
  {#each messages as m, i (i)}
    {#if m.self}
      <!-- self: right, brand bubble, tail bottom-right -->
      <div class="group flex flex-col items-end">
        <div class="max-w-[min(70%,36rem)] rounded-2xl rounded-br-md bg-brand px-4 py-2.5 text-sm text-white shadow-sm whitespace-pre-wrap break-words">
          {m.payload}
        </div>
        <div class="mt-1 flex items-center gap-2 text-xs text-zinc-400">
          <span>{fmtTime(m.ts)}</span>
          <span class="text-zinc-500">{displayNick(m)}</span>
          <span class="flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
            <button class="hover:text-zinc-600" title="Copy" onclick={() => onCopy(m.payload)}>Copy</button>
            <button class="hover:text-red-600" title="Delete (local)" onclick={() => onDelete(i)}>Delete</button>
          </span>
        </div>
      </div>
    {:else}
      <!-- other: left, avatar + name + grey bubble, tail top-left -->
      <div class="group flex gap-3">
        <div
          class="mt-5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
          style="background:{hashColor(m.from)}"
        >
          {avatarSrc(m)}
        </div>
        <div class="min-w-0 flex-1">
          <div class="mb-1 truncate text-sm font-medium text-zinc-700" title={displayNick(m)}>{displayNick(m)}</div>
          <div class="inline-block max-w-[min(70%,36rem)] rounded-2xl rounded-tl-md bg-zinc-100 px-4 py-2.5 text-sm text-zinc-900 whitespace-pre-wrap break-words">
            {m.payload}
          </div>
          <div class="mt-1 flex items-center gap-2 text-xs text-zinc-400">
            <span>{fmtTime(m.ts)}</span>
            <span class="flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
              <button class="hover:text-zinc-600" title="Copy" onclick={() => onCopy(m.payload)}>Copy</button>
              <button class="hover:text-red-600" title="Delete (local)" onclick={() => onDelete(i)}>Delete</button>
            </span>
          </div>
        </div>
      </div>
    {/if}
  {/each}
</div>
