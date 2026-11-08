export type Health = "healthy" | "down"

export interface UpstreamCounters {
  fails: number
  requests: number
}

export type UpstreamsReply =
  | { ok: true; upstreams: Record<string, UpstreamCounters> }
  | { ok: false; error: string }

export interface UpstreamHealth {
  health: Health
  fails: number
}

/** Caddy keys upstreams by dial address; the graph labels may carry an https:// prefix. */
export const upstreamAddress = (label: string) => label.replace(/^https?:\/\//, "")

/**
 * Health of one upstream label. Null whenever Caddy gave no answer for it: an unreadable reply,
 * or an address it does not know (for example one that only exists in the editor).
 * An upstream with recent failures counts as down.
 */
export function upstreamHealth(label: string, reply: UpstreamsReply | null): UpstreamHealth | null {
  if (!reply?.ok) return null
  const counters = reply.upstreams[upstreamAddress(label)]
  if (!counters) return null
  return { health: counters.fails > 0 ? "down" : "healthy", fails: counters.fails }
}

/** The worst state of several members; null when none of them has a known state. */
export function worstHealth(states: (UpstreamHealth | null)[]): Health | null {
  const known = states.filter((state): state is UpstreamHealth => state !== null)
  if (known.length === 0) return null
  return known.some((state) => state.health === "down") ? "down" : "healthy"
}
