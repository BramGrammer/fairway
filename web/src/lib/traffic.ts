import type { HostStats } from "./api"

export function mergeStats(list: HostStats[]): HostStats | null {
  if (list.length === 0) return null
  const length = Math.max(...list.map((s) => s.history.length))
  const history = Array.from({ length }, (_, i) =>
    list.reduce((sum, s) => sum + (s.history[s.history.length - length + i] ?? 0), 0),
  )
  const requests = list.reduce((sum, s) => sum + s.requests, 0)
  const sum = (pick: (s: HostStats) => number) => list.reduce((total, s) => total + pick(s), 0)
  return {
    requests,
    codes: {
      "2xx": sum((s) => s.codes["2xx"]),
      "3xx": sum((s) => s.codes["3xx"]),
      "4xx": sum((s) => s.codes["4xx"]),
      "5xx": sum((s) => s.codes["5xx"]),
      other: sum((s) => s.codes.other),
    },
    bytes: sum((s) => s.bytes),
    inFlight: sum((s) => s.inFlight),
    rate: sum((s) => s.rate),
    avgMs: requests > 0 ? list.reduce((total, s) => total + s.avgMs * s.requests, 0) / requests : 0,
    history,
  }
}

export type CodeClass = "2xx" | "3xx" | "4xx" | "5xx"
export const CODE_CLASSES: CodeClass[] = ["2xx", "3xx", "4xx", "5xx"]

/** Each status class as a fraction of all requests in the window. */
export function codeSplit(stats: HostStats): { key: CodeClass; count: number; share: number }[] {
  return CODE_CLASSES.map((key) => ({
    key,
    count: stats.codes[key],
    share: stats.requests > 0 ? stats.codes[key] / stats.requests : 0,
  }))
}

export interface Contribution {
  host: string
  /** How much of that host's traffic reaches the node, 0 to 1. */
  fraction: number
}

/**
 * Which hosts feed a node and how much of each one's traffic. Caddy counts per host, not per path,
 * so a Rule or Destination gets its host's traffic split evenly over the host's paths.
 */
export function trafficContributions<P extends { host: string }>(
  paths: P[],
  touches: (path: P) => boolean,
  wholeHost: boolean,
): Contribution[] {
  const total = new Map<string, number>()
  const hit = new Map<string, number>()
  for (const path of paths) {
    total.set(path.host, (total.get(path.host) ?? 0) + 1)
    if (touches(path)) hit.set(path.host, (hit.get(path.host) ?? 0) + 1)
  }
  return [...hit].map(([host, count]) => ({ host, fraction: wholeHost ? 1 : count / (total.get(host) ?? 1) }))
}

const scale = (stats: HostStats, f: number): HostStats => ({
  ...stats,
  requests: stats.requests * f,
  codes: {
    "2xx": stats.codes["2xx"] * f,
    "3xx": stats.codes["3xx"] * f,
    "4xx": stats.codes["4xx"] * f,
    "5xx": stats.codes["5xx"] * f,
    other: stats.codes.other * f,
  },
  bytes: stats.bytes * f,
  inFlight: stats.inFlight * f,
  rate: stats.rate * f,
  history: stats.history.map((v) => v * f),
})

/** Estimated traffic for a node fed by several hosts, and its share of those hosts' traffic. Null when no host has data. */
export function estimateTraffic(
  parts: { stats: HostStats | null; fraction: number }[],
): { stats: HostStats; share: number } | null {
  const known = parts.filter((p): p is { stats: HostStats; fraction: number } => p.stats !== null)
  const merged = mergeStats(known.map((p) => scale(p.stats, p.fraction)))
  if (!merged) return null
  const whole = known.reduce((sum, p) => sum + p.stats.requests, 0)
  return { stats: merged, share: whole > 0 ? merged.requests / whole : 0 }
}
