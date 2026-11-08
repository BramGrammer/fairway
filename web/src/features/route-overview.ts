import type { Chip, Destination, Site } from "@/lib/api"

/** What the graph knows, in the shape the Overview needs (structurally the graph's own `Raw`). */
export interface OverviewData {
  raw: {
    hosts: Map<string, { site: Site }>
    handlers: Map<string, { chips: Chip[] }>
    /** Single middleware nodes, when the graph draws them one by one. */
    steps?: Map<string, { chip: Chip }>
    dests: Map<string, { dest: Destination }>
    paths: { host: string; handler: string; dest: string; match: string; steps?: string[] }[]
  }
  groups: { id: string; label: string; column: "host" | "dest"; members: string[] }[]
  /** Requests per destination id while traffic is known; null otherwise. */
  destWeights: Map<string, number> | null
}

export interface DestView {
  id: string
  label: string
  dest: Destination
}

export interface RuleInstance {
  hosts: string[]
  listen: string[]
  match: string
  /** How many other rules the Site has; zero means this rule takes every request. */
  siblings: number
  inherited: Chip[]
  own: Chip[]
  destinations: DestView[]
}

export type NodeOverview =
  | { kind: "site"; hosts: string[]; listen: string[]; middleware: Chip[]; rules: Site["rules"] }
  | { kind: "rule"; middleware: Chip[]; instances: RuleInstance[] }
  | {
      kind: "destination"
      dest: Destination
      sources: { hosts: string[]; match: string; siblings: number }[]
      share: number | null
    }
  | { kind: "group"; label: string; members: { id: string; label: string; sub?: string }[] }

export const destLabel = (dest: Destination) =>
  dest.kind === "proxy" && dest.upstreams?.length ? dest.upstreams.join(", ") : dest.summary

function memberLabel(data: OverviewData, id: string): { label: string; sub?: string } {
  const site = data.raw.hosts.get(id)?.site
  if (site) return { label: site.hosts.join(", "), sub: site.listen.join(", ") || undefined }
  const dest = data.raw.dests.get(id)?.dest
  return { label: dest ? destLabel(dest) : id }
}

export function describeNode(data: OverviewData, id: string): NodeOverview | null {
  const { raw } = data

  const group = data.groups.find((g) => g.id === id)
  if (group) {
    return {
      kind: "group",
      label: group.label,
      members: group.members.map((member) => ({ id: member, ...memberLabel(data, member) })),
    }
  }

  const host = raw.hosts.get(id)
  if (host) {
    const { site } = host
    return { kind: "site", hosts: site.hosts, listen: site.listen, middleware: site.middleware, rules: site.rules }
  }

  const handler = raw.handlers.get(id)
  const step = raw.steps?.get(id)
  if (handler || step) {
    const instances = new Map<string, RuleInstance>()
    for (const path of raw.paths.filter((p) => p.handler === id || (p.steps ?? []).includes(id))) {
      const site = raw.hosts.get(path.host)?.site
      const dest = raw.dests.get(path.dest)
      if (!site || !dest) continue
      const key = `${path.host}|${path.match}`
      let instance = instances.get(key)
      if (!instance) {
        const rule = site.rules.find((r) => r.match === path.match)
        instance = {
          hosts: site.hosts,
          listen: site.listen,
          match: path.match,
          siblings: site.rules.length - 1,
          inherited: site.middleware,
          own: rule?.middleware ?? [],
          destinations: [],
        }
        instances.set(key, instance)
      }
      instance.destinations.push({ id: path.dest, label: destLabel(dest.dest), dest: dest.dest })
    }
    return { kind: "rule", middleware: handler ? handler.chips : [step!.chip], instances: [...instances.values()] }
  }

  const dest = raw.dests.get(id)
  if (dest) {
    const seen = new Set<string>()
    const sources: { hosts: string[]; match: string; siblings: number }[] = []
    for (const path of raw.paths.filter((p) => p.dest === id)) {
      const key = `${path.host}|${path.match}`
      const site = raw.hosts.get(path.host)?.site
      if (!site || seen.has(key)) continue
      seen.add(key)
      sources.push({ hosts: site.hosts, match: path.match, siblings: site.rules.length - 1 })
    }
    let share: number | null = null
    if (data.destWeights) {
      const total = [...data.destWeights.values()].reduce((sum, n) => sum + n, 0)
      share = total > 0 ? (data.destWeights.get(id) ?? 0) / total : null
    }
    return { kind: "destination", dest: dest.dest, sources, share }
  }

  return null
}
