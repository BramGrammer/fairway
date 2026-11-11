import type { Chip, Destination, Rule, Site } from "./api.js"
import { parsePersistedTable, type PersistedTableOf } from "./table-state.js"

export const COLUMN_IDS = ["host", "path", "destination", "middleware", "activity"] as const
export type ColumnId = (typeof COLUMN_IDS)[number]

export interface RouteRow {
  /** Stable key: the position of the Site, host and rule. */
  id: string
  host: string
  listen: string[]
  rule: Rule | null
  siteMiddleware: Chip[]
}

/** The most chips or destinations shown inline before the rest collapse into "+N". */
export const MAX_CHIPS = 2

/** One row per host x route; a Site without rules gives one row per host. */
export function flattenSites(sites: Site[]): RouteRow[] {
  const rows: RouteRow[] = []
  sites.forEach((site, s) => {
    for (const host of site.hosts) {
      const rules: (Rule | null)[] = site.rules.length > 0 ? site.rules : [null]
      rules.forEach((rule, r) => {
        rows.push({ id: `${s}:${host}:${r}`, host, listen: site.listen, rule, siteMiddleware: site.middleware })
      })
    }
  })
  return rows
}

/** For each row, whether it repeats the host of the row above it. */
export function repeatFlags(hosts: string[]): boolean[] {
  return hosts.map((host, i) => i > 0 && hosts[i - 1] === host)
}

/** The rule's matchers, falling back to the match text when the server sent none. */
export function matcherChips(rule: Rule | null): Chip[] {
  if (!rule) return []
  if (rule.matchers) return rule.matchers
  return rule.match ? [{ label: rule.match }] : []
}

/** Splits a list into what is shown and how many are hidden. */
export function collapse<T>(items: T[], max = MAX_CHIPS): { shown: T[]; more: number } {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) }
}

/** The middleware that applies to the row: site-wide plus the rule's own. */
export function middlewareCount(row: Pick<RouteRow, "siteMiddleware" | "rule">): number {
  return row.siteMiddleware.length + (row.rule?.middleware.length ?? 0)
}

/** The addresses of a destination, one per upstream, or its summary when it has none. */
export function destinationLabels(dest: Destination): string[] {
  return dest.kind === "proxy" && dest.upstreams?.length ? dest.upstreams : [dest.summary]
}

/** First destination label and how many more there are across all destinations. */
export function destinationSummary(rule: Rule | null): { first: Destination | null; label: string; more: number } {
  if (!rule || rule.destinations.length === 0) return { first: null, label: "", more: 0 }
  const labels = rule.destinations.flatMap(destinationLabels)
  return { first: rule.destinations[0], label: labels[0] ?? "", more: labels.length - 1 }
}

export const sortKeys = {
  host: (row: RouteRow) => row.host,
  path: (row: RouteRow) => row.rule?.match ?? "",
  destination: (row: RouteRow) => destinationSummary(row.rule).label,
  middleware: (row: RouteRow) => middlewareCount(row),
}

/** Reads stored table state; anything unexpected is dropped, never thrown. */
export function parsePersisted(raw: string | null): PersistedTableOf<ColumnId> {
  return parsePersistedTable(raw, COLUMN_IDS, ["activity"])
}
