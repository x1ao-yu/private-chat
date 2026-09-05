<script lang="ts">
  import type { ChatMessage } from "./channel.svelte.ts";

  let {
    messages,
    peerNicks = new Map<string, string>(),
    selfNicks = new Map<string, string>(),
    roomId = "",
    peerNicksVersion = 0,
    onCopy,
    onDelete,
  }: {
    messages: ChatMessage[];
    peerNicks?: Map<string, string>;
    selfNicks?: Map<string, string>;
    roomId?: string;
    peerNicksVersion?: number;
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
    // signed messages carry the sender's nick inside the verified payload;
    // fall back to the per-room nick map, then the ephemeral connection id
    if (m.ident?.nick && m.ident.status !== "invalid") return m.ident.nick;
    return peerNicks.get(`${roomId}:${m.from}`) ?? m.from;
  }
  function identTitle(m: ChatMessage): string {
    const i = m.ident!;
    if (i.status === "verified") return `Identity verified (TOFU, this session) · pk ${i.pk}`;
    if (i.status === "conflict") return `⚠️ Same nick claimed by a different identity · claimed pk ${i.pk}`;
    return `⚠️ Signature invalid — content hidden · claimed pk ${i.pk}`;
  }
  function identChipClass(m: ChatMessage): string {
    const s = m.ident!.status;
    if (s === "verified") return "bg-zinc-100 text-zinc-500";
    if (s === "conflict") return "bg-amber-100 text-amber-700";
    return "bg-red-100 text-red-700";
  }
  function avatarColor(m: ChatMessage): string {
    // identity fingerprint is stable across reconnects; conn id is not
    return hashColor(m.ident ? m.ident.fp : m.from);
  }
  function sysText(m: ChatMessage): string {
    if (!m.sys) return m.payload;
    // read inside render: re-resolves when a nick arrives after the frame
    void peerNicksVersion;
    const nick = peerNicks.get(`${roomId}:${m.sys.actor}`) ?? m.sys.actor;
    if (m.sys.sysKind === "room_name") return `🏷️ Room name updated to "${m.payload}" by ${nick}`;
    if (m.sys.sysKind === "key_rotation") return `🔑 Key rotated by ${nick}`;
    if (m.sys.sysKind === "identity_conflict")
      return `⚠️ Nick "${m.sys.nick}" is now claimed by a different session identity (${m.sys.fp}…) — could be a fresh session identity or impersonation`;
    return m.payload;
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
          {#if m.ident}
            <span
              class="flex items-center gap-1 rounded-full {identChipClass(m)} px-1.5 py-0.5 text-[10px]"
              title={identTitle(m)}
            >
              {#if m.ident.status !== "verified"}⚠️{/if}
              <span class="h-1.5 w-1.5 rounded-full" style="background:{hashColor(m.ident.fp)}"></span>
              {m.ident.fp}…
            </span>
          {:else if m.from !== "system"}
            <span
              class="shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-400"
              title="Sent without identity signature — unauthenticated (legacy client or identity auth unavailable)"
            >
              no identity
            </span>
          {/if}
          <span class="text-zinc-500">{displayNick(m)}</span>
          <span class="flex gap-2 opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100">
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
          style="background:{avatarColor(m)}"
        >
          {avatarSrc(m)}
        </div>
        <div class="min-w-0 flex-1">
          <div class="mb-1 flex items-center gap-1.5 text-sm font-medium text-zinc-700">
            <span class="truncate" title={displayNick(m)}>{displayNick(m)}</span>
            {#if m.ident}
              <span
                class="flex shrink-0 items-center gap-1 rounded-full {identChipClass(m)} px-1.5 py-0.5 text-[10px]"
                title={identTitle(m)}
              >
                {#if m.ident.status !== "verified"}⚠️{/if}
                <span class="h-1.5 w-1.5 rounded-full" style="background:{hashColor(m.ident.fp)}"></span>
                {m.ident.fp}…
              </span>
            {:else if m.from !== "system"}
              <span
                class="shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-400"
                title="Sent without identity signature — unauthenticated (legacy client or identity auth unavailable)"
              >
                no identity
              </span>
            {/if}
          </div>
          <div class="inline-block max-w-[min(70%,36rem)] rounded-2xl rounded-tl-md bg-zinc-100 px-4 py-2.5 text-sm text-zinc-900 whitespace-pre-wrap break-words">
            {m.sys ? sysText(m) : m.payload}
          </div>
          <div class="mt-1 flex items-center gap-2 text-xs text-zinc-400">
            <span>{fmtTime(m.ts)}</span>
            <span class="flex gap-2 opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100">
              <button class="hover:text-zinc-600" title="Copy" onclick={() => onCopy(m.payload)}>Copy</button>
              <button class="hover:text-red-600" title="Delete (local)" onclick={() => onDelete(i)}>Delete</button>
            </span>
          </div>
        </div>
      </div>
    {/if}
  {/each}
</div>
