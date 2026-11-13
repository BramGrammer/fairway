import type { StatusClass } from "./host-log-filter"

export type TimeRange = "any" | "1h" | "24h" | "7d"

const RANGE_MS: Record<Exclude<TimeRange, "any">, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
}

/**
 * The smallest range whose start is no later than the end of the period, so the lines of the period's end are in it;
 * null when even 7 days back does not reach, because then no range would show them.
 */
export function rangeCovering(periodEnd: number, now: number): Exclude<TimeRange, "any"> | null {
  const age = Math.max(0, now - periodEnd)
  return (["1h", "24h", "7d"] as const).find((range) => age <= RANGE_MS[range]) ?? null
}

/** The filters the server applies while it reads the log. */
export interface ServerLogFilter {
  /** Status classes to keep; empty keeps every class. */
  classes: StatusClass[]
  /** Only requests whose path starts with this; blank keeps every path. */
  path: string
  /** Only requests from this exact address; blank keeps every client. */
  client: string
  range: TimeRange
}

export const NO_SERVER_FILTER: ServerLogFilter = { classes: [], path: "", client: "", range: "any" }

export function isServerFiltering(filter: ServerLogFilter): boolean {
  return filter.classes.length > 0 || filter.path.trim() !== "" || filter.client.trim() !== "" || filter.range !== "any"
}

/** The filter a link to the Logs tab carries, from the routes page's URL parameters. */
export function filterFromParams(params: { client?: string; path?: string; status?: StatusClass; range?: Exclude<TimeRange, "any"> }): ServerLogFilter {
  return { classes: params.status ? [params.status] : [], path: params.path ?? "", client: params.client ?? "", range: params.range ?? "any" }
}

/** The query string (without the host) that carries a filter to the server; `now` is epoch milliseconds. */
export function serverFilterParams(filter: ServerLogFilter, now: number): URLSearchParams {
  const params = new URLSearchParams()
  const classes = filter.classes.filter((c) => c !== "other")
  if (classes.length > 0) params.set("status", classes.join(","))
  if (filter.path.trim()) params.set("path", filter.path.trim())
  if (filter.client.trim()) params.set("client", filter.client.trim())
  if (filter.range !== "any") params.set("from", String(now - RANGE_MS[filter.range]))
  return params
}
