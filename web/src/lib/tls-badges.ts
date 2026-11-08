export type Severity = "ok" | "amber" | "red"

export type TlsStatusReply =
  | {
      ok: true
      enabled: boolean
      sweptAt?: string
      hosts: Record<string, { severity: Severity; reasons: string[] }>
    }
  | { ok: false; error: string }

export interface TlsBadge {
  severity: "amber" | "red"
  title: string
}

const RANK: Record<Severity, number> = { ok: 0, amber: 1, red: 2 }

/** The worst swept state among hosts, or null when all are healthy or unknown. Only amber and red count. */
function worst(hosts: string[], reply: TlsStatusReply | null): { severity: "amber" | "red"; reasons: string[] } | null {
  if (!reply?.ok || !reply.enabled) return null
  let found: { severity: "amber" | "red"; reasons: string[] } | null = null
  for (const host of hosts) {
    const state = reply.hosts[host]
    if (!state || state.severity === "ok") continue
    if (!found || RANK[state.severity] > RANK[found.severity]) {
      found = { severity: state.severity, reasons: state.reasons }
    }
  }
  return found
}

/** Badge for one Site (all its hosts); healthy and unprobed Sites get none. */
export function hostBadge(hosts: string[], reply: TlsStatusReply | null): TlsBadge | null {
  const found = worst(hosts, reply)
  return found && { severity: found.severity, title: found.reasons.join(" ") }
}

/** Badge for a group node: the worst state of its member Sites. */
export function groupBadge(members: string[][], reply: TlsStatusReply | null): TlsBadge | null {
  const found = worst(members.flat(), reply)
  if (!found) return null
  return {
    severity: found.severity,
    title: `Worst Certificate state in this group: ${found.severity === "red" ? "problem" : "needs attention"}`,
  }
}
