// invite.ts — pure parsing for invite links and URL-hash keys (P3)

export interface Invite {
  id: string;
  key: string | null;
}

const INVITE_RE = /\/r\/([a-zA-Z0-9_-]{1,64})(?:#k=([^&\s]+))?/;

export function parseInvite(raw: string): Invite {
  const s = raw.trim();
  const m = s.match(INVITE_RE);
  if (m) return { id: m[1], key: m[2] ? decodeKeyParam(m[2]) : null };
  return { id: s, key: null };
}

export function parseKeyFromHash(hash: string): string | null {
  if (!hash) return null;
  const m = hash.match(/[#&]k=([^&]+)/) || hash.match(/[#&]key=([^&]+)/);
  return m ? decodeKeyParam(m[1]) : null;
}

// malformed %-encoding must not throw; the raw value is rejected later by key validation
function decodeKeyParam(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}
