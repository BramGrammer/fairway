export type TimelineState = "ok" | "warning" | "down" | "unknown"

export interface TimelineInterval {
  from: number
  to: number
  state: TimelineState
}

export type TimelineReply =
  | { ok: true; from: number; to: number; hosts: Record<string, TimelineInterval[]> }
  | { ok: false; error?: string }

export interface Segment {
  state: TimelineState
  from: number
  to: number
  /** Share of the window, 0 to 100. */
  widthPct: number
}

export const STATE_LABELS: Record<TimelineState, string> = {
  ok: "Up",
  warning: "Degraded",
  down: "Down",
  unknown: "Not watching",
}

/** Clamps the intervals to the window, drops empty ones and merges neighbours that share a state. */
export function toSegments(intervals: TimelineInterval[], from: number, to: number): Segment[] {
  const span = to - from
  if (span <= 0) return []
  const merged: { state: TimelineState; from: number; to: number }[] = []
  for (const interval of [...intervals].sort((a, b) => a.from - b.from)) {
    const start = Math.max(interval.from, from)
    const end = Math.min(interval.to, to)
    if (end <= start) continue
    const last = merged[merged.length - 1]
    if (last && last.state === interval.state && start <= last.to) last.to = Math.max(last.to, end)
    else merged.push({ state: interval.state, from: start, to: end })
  }
  return merged.map((part) => ({ ...part, widthPct: ((part.to - part.from) / span) * 100 }))
}

/** "3h 20m", "45m", "30s": a duration in a few characters. */
export function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

/** Tooltip text for one segment, such as "Down, 02:10 to 02:40 (30m)". */
export function segmentLabel(segment: Pick<Segment, "state" | "from" | "to">): string {
  return `${STATE_LABELS[segment.state]}, ${clock(segment.from)} to ${clock(segment.to)} (${formatSpan(segment.to - segment.from)})`
}

/** Number of separate stretches in the Down state. */
export function outageCount(segments: Segment[]): number {
  return segments.filter((segment) => segment.state === "down").length
}

/** One line under the strip, e.g. "2 outages in 24 h". */
export function summarize(segments: Segment[], windowMs: number): string {
  const label = windowMs % 3_600_000 === 0 ? `${windowMs / 3_600_000} h` : formatSpan(windowMs)
  if (segments.every((segment) => segment.state === "unknown")) return "No data yet"
  const count = outageCount(segments)
  if (count === 0) return `No outages in ${label}`
  return `${count} ${count === 1 ? "outage" : "outages"} in ${label}`
}
