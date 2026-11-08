import type { Chip, Destination, Site } from "@/lib/api"

/** The query as compared: trimmed and lowercased, so matching is case-insensitive. */
export const normalizeQuery = (query: string) => query.trim().toLowerCase()

/** True when the (already normalized) query is empty or appears in any of the texts. */
export const matchesQuery = (query: string, texts: string[]) =>
  !query || texts.some((text) => text.toLowerCase().includes(query))

export const hostTexts = (site: Site) => site.hosts

export const chipTexts = (chips: Chip[]) => chips.map((chip) => chip.label)

export const destTexts = (dest: Destination) => [dest.summary, ...(dest.upstreams ?? [])]

/** Whether a site has a hostname, upstream or Middleware label matching the query. */
export function siteMatches(site: Site, query: string): boolean {
  return matchesQuery(query, [
    ...hostTexts(site),
    ...chipTexts(site.middleware),
    ...site.rules.flatMap((rule) => [...chipTexts(rule.middleware), ...rule.destinations.flatMap(destTexts)]),
  ])
}
