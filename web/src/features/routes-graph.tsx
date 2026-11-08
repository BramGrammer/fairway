import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CircleQuestionMarkIcon,
  CornerDownRightIcon,
  FolderIcon,
  InfoIcon,
  LockIcon,
  MessageSquareIcon,
  PinIcon,
  XIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { RouteDrawer } from "@/features/route-drawer"
import { TlsTab } from "@/features/tls-tab"
import { TrafficTab } from "@/features/traffic-tab"
import { RouteOverview } from "@/features/route-overview-view"
import { useMetrics } from "@/hooks/use-metrics"
import { useUpstreamHealth } from "@/hooks/use-upstream-health"
import { HealthDot } from "@/features/health-dot"
import { TlsBadge } from "@/features/tls-badge"
import { useTlsStatus } from "@/hooks/use-tls-status"
import { groupBadge, hostBadge } from "@/lib/tls-badges"
import { upstreamHealth, worstHealth } from "@/lib/upstream-health"
import type { Chip, Destination, HostStats, Site } from "@/lib/api"
import { nodeKind } from "@/lib/route-drawer"
import { orderLayers, type Layers, type Link, type Unit } from "@/lib/graph-order"
import { estimateTraffic, mergeStats, trafficContributions } from "@/lib/traffic"
import { chipTexts, destTexts, hostTexts, matchesQuery } from "@/features/routes-filter"
import { PRESSED } from "@/lib/toggle-styles"
import { cn } from "@/lib/utils"

const DEST_ICONS = {
  proxy: ArrowRightIcon,
  file: FolderIcon,
  redirect: CornerDownRightIcon,
  respond: MessageSquareIcon,
  other: CircleQuestionMarkIcon,
} as const

const PAD = 16
const SIDE_W = 190
const STEP_W = 150
const STEP_H = 44
const WP_H = 4
const MIN_COL_GAP = 36
const HOST_H = 44
const GROUP_H = 64
const HEADER_H = 28
const DEST_H = 32
const MIN_GAP = 8

interface HostNode {
  id: string
  site: Site
  routes: number
}

interface HandlerNode {
  id: string
  chips: Chip[]
}

/** One middleware, shared by every path that passes through it. */
interface StepNode {
  id: string
  chip: Chip
}

interface DestNode {
  id: string
  dest: Destination
}

interface Path {
  host: string
  handler: string
  dest: string
  match: string
  /** The middleware this path passes through, in order. */
  steps: string[]
}

interface Raw {
  hosts: Map<string, HostNode>
  handlers: Map<string, HandlerNode>
  steps: Map<string, StepNode>
  dests: Map<string, DestNode>
  paths: Path[]
}

interface Group {
  id: string
  label: string
  column: "host" | "dest"
  members: string[]
  internal: boolean
}

/** A point that carries a line past a column it has no box in. */
interface Waypoint {
  from: string
  to: string
  col: number
}

interface Arranged {
  /** The columns between hosts and destinations, each listing its boxes and waypoints top to bottom. */
  middle: string[][]
  waypoints: Map<string, Waypoint>
  /** What each path visits from host to destination: boxes and waypoints. */
  chains: Map<Path, string[]>
  hostGroups: Group[]
  destGroups: Group[]
  groupOf: Map<string, Group>
}

const isHostNode = (id: string) => id.startsWith("host:") || id.startsWith("host-group:")
const hostLabel = (host: string) => (host === "*" ? "any host" : host)
const isDomain = (host: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)
const isInternal = (site: Site) => site.hosts.some((host) => host.includes(".int."))
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

function uniqueChips(chips: Chip[]): Chip[] {
  const seen = new Set<string>()
  return chips.filter((chip) => {
    const key = `${chip.label}|${chip.detail ?? ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const stepId = (chip: Chip) => `mw:${chip.label}`

/** Every route as a path: host -> the middleware stack it passes through -> where it ends up. */
function buildRaw(sites: Site[]): Raw {
  const raw: Raw = { hosts: new Map(), handlers: new Map(), steps: new Map(), dests: new Map(), paths: [] }
  for (const site of sites) {
    const hostId = `host:${site.hosts.join(",")}|${site.listen.join(",")}`
    raw.hosts.set(hostId, { id: hostId, site, routes: site.rules.length })

    for (const rule of site.rules) {
      const chips = uniqueChips([...site.middleware, ...rule.middleware])
      const handlerId = `handler:${chips.map((chip) => chip.label).join("|")}`
      if (!raw.handlers.has(handlerId)) raw.handlers.set(handlerId, { id: handlerId, chips })
      const steps = [...new Set(chips.map(stepId))]
      for (const chip of chips) if (!raw.steps.has(stepId(chip))) raw.steps.set(stepId(chip), { id: stepId(chip), chip })

      for (const dest of rule.destinations) {
        const targets =
          dest.kind === "proxy"
            ? (dest.upstreams ?? []).map((upstream) => ({
                id: `proxy:${upstream}`,
                dest: { ...dest, upstreams: [upstream] },
              }))
            : [{ id: `${dest.kind}:${dest.summary}`, dest }]
        for (const target of targets) {
          if (!raw.dests.has(target.id)) raw.dests.set(target.id, target)
          raw.paths.push({ host: hostId, handler: handlerId, dest: target.id, match: rule.match, steps })
        }
      }
    }
  }
  return raw
}

const hostGroupLabel = (site: Site) => {
  const first = site.hosts[0] ?? ""
  const domain = isDomain(first) ? first.split(".").slice(-2).join(".") : "Other"
  return isInternal(site) ? `Internal · ${domain}` : domain
}

/** Upstreams group by machine (everything before the port); redirects, files and responses go together. */
const destGroupLabel = (dest: Destination) =>
  dest.kind === "proxy" ? (dest.upstreams?.[0] ?? "").replace(/:\d+$/, "") : "Built-in"

/** Puts each middleware one column after the last one that comes before it on any path. */
function layerSteps(paths: Path[]): Map<string, number> {
  const layer = new Map<string, number>()
  const links: [string, string][] = []
  for (const path of paths) {
    path.steps.forEach((id, i) => {
      layer.set(id, 1)
      if (i > 0) links.push([path.steps[i - 1], id])
    })
  }
  // The pass limit also stops an inconsistent order (A before B on one path, after it on another) from growing forever.
  for (let pass = 0; pass < layer.size; pass++) {
    let changed = false
    for (const [a, b] of links) {
      const next = (layer.get(a) ?? 1) + 1
      if ((layer.get(b) ?? 1) < next) {
        layer.set(b, next)
        changed = true
      }
    }
    if (!changed) break
  }
  return layer
}

/** Order the columns to keep crossings down, and gather hosts and destinations into groups. */
function arrange(raw: Raw, paths: Path[]): Arranged {
  const hostIds = new Set(paths.map((p) => p.host))
  const destIds = new Set(paths.map((p) => p.dest))

  const hosts = [...raw.hosts.values()]
    .filter((host) => hostIds.has(host.id))
    .sort((a, b) => (a.site.hosts[0] ?? "").localeCompare(b.site.hosts[0] ?? ""))

  const groupOf = new Map<string, Group>()
  const collect = (
    column: "host" | "dest",
    items: { id: string; label: string; internal: boolean }[],
    order: (a: Group, b: Group) => number,
  ) => {
    const groups = new Map<string, Group>()
    for (const item of items) {
      const group = groups.get(item.label) ?? {
        id: `${column}-group:${item.label}`,
        label: item.label,
        column,
        members: [],
        internal: item.internal,
      }
      group.members.push(item.id)
      groups.set(item.label, group)
      groupOf.set(item.id, group)
    }
    return [...groups.values()].sort(order)
  }

  const bySize = (a: Group, b: Group) => b.members.length - a.members.length || a.label.localeCompare(b.label)
  const hostGroups = collect(
    "host",
    hosts.map((host) => ({ id: host.id, label: hostGroupLabel(host.site), internal: isInternal(host.site) })),
    (a, b) => Number(a.internal) - Number(b.internal) || bySize(a, b),
  )
  const hostOrder = new Map(hostGroups.flatMap((g) => g.members).map((id, i) => [id, i]))

  const barycenter = (destId: string) => {
    const from = paths.filter((p) => p.dest === destId).map((p) => hostOrder.get(p.host) ?? 0)
    return from.reduce((sum, n) => sum + n, 0) / Math.max(from.length, 1)
  }
  const dests = [...raw.dests.values()]
    .filter((dest) => destIds.has(dest.id))
    .sort((a, b) => barycenter(a.id) - barycenter(b.id))
  const destGroups = collect(
    "dest",
    dests.map((dest) => ({ id: dest.id, label: destGroupLabel(dest.dest), internal: false })),
    (a, b) => Number(a.label === "Built-in") - Number(b.label === "Built-in") || bySize(a, b),
  )

  // Every path becomes a chain from host to destination; a line that skips columns gets a waypoint in each.
  const layer = layerSteps(paths)
  const last = Math.max(0, ...layer.values()) + 1
  const waypoints = new Map<string, Waypoint>()
  const chains = new Map<Path, string[]>()
  for (const path of paths) {
    const nodes = [path.host, ...path.steps, path.dest]
    const cols = [0, ...path.steps.map((id) => layer.get(id) ?? 1), last]
    const chain = [path.host]
    for (let i = 1; i < nodes.length; i++) {
      for (let col = cols[i - 1] + 1; col < cols[i]; col++) {
        const id = `wp:${nodes[i - 1]}>${nodes[i]}@${col}`
        waypoints.set(id, { from: nodes[i - 1], to: nodes[i], col })
        chain.push(id)
      }
      chain.push(nodes[i])
    }
    chains.set(path, chain)
  }

  // The orders above are a starting point; refine them so that as few lines as possible cross.
  const toUnits = (groups: Group[]): Unit[] => groups.map((group) => ({ key: group.label, members: group.members }))
  const single = (id: string): Unit => ({ key: id, members: [id] })
  const middle: Unit[][] = Array.from({ length: last - 1 }, (_, k) => [
    ...[...layer].filter(([, l]) => l === k + 1).map(([id]) => single(id)),
    ...[...waypoints].filter(([, w]) => w.col === k + 1).map(([id]) => single(id)),
  ])
  const links: Link[] = [...chains.values()].flatMap((chain) =>
    chain.slice(1).map((id, i): Link => [chain[i], id]),
  )
  const ordered: Layers = orderLayers(links, [toUnits(hostGroups), ...middle, toUnits(destGroups)])

  const reorder = (groups: Group[], units: Unit[]) =>
    units.map((unit) => {
      const group = groups.find((g) => g.label === unit.key) as Group
      group.members = unit.members
      return group
    })

  return {
    middle: ordered.slice(1, -1).map((units) => units.flatMap((unit) => unit.members)),
    waypoints,
    chains,
    hostGroups: reorder(hostGroups, ordered[0]),
    destGroups: reorder(destGroups, ordered[ordered.length - 1]),
    groupOf,
  }
}

type Item =
  | { kind: "member"; id: string; height: number }
  | { kind: "group"; id: string; group: Group; height: number }
  | { kind: "header"; id: string; group: Group; height: number }

/** A column's boxes top to bottom: a collapsed group is one box, an open one a header plus its members. */
function columnItems(groups: Group[], expanded: Set<string>, memberHeight: number): Item[] {
  return groups.flatMap((group): Item[] => {
    const members = group.members.map((id): Item => ({ kind: "member", id, height: memberHeight }))
    if (group.members.length === 1) return members
    if (!expanded.has(group.id)) return [{ kind: "group", id: group.id, group, height: GROUP_H }]
    return [{ kind: "header", id: `${group.id}:header`, group, height: HEADER_H }, ...members]
  })
}

const usedHeight = (heights: number[]) => heights.reduce((sum, h) => sum + h, 0) + MIN_GAP * (heights.length + 1)

/** Spread a column's boxes over the full height so short columns sit centred between long ones. */
function stack(heights: number[], total: number): number[] {
  const gap = Math.max(MIN_GAP, (total - heights.reduce((sum, h) => sum + h, 0)) / (heights.length + 1))
  let y = gap
  return heights.map((height) => {
    const top = y
    y += height + gap
    return top
  })
}

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const mid = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
}

interface Edge {
  key: string
  from: string
  to: string
  count: number
  d: string
}

type Weighting = "routes" | "traffic"

/** Rolling windows the server keeps history for. */
const WINDOWS = [
  { seconds: 300, short: "5m", phrase: "5 minutes" },
  { seconds: 900, short: "15m", phrase: "15 minutes" },
  { seconds: 3600, short: "1h", phrase: "hour" },
  { seconds: 86400, short: "24h", phrase: "24 hours" },
] as const

const fmtSpan = (ms: number) => {
  const minutes = Math.round(ms / 60_000)
  return minutes < 1 ? `${Math.round(ms / 1000)} s` : minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`
}

const fmtCount = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n))
const fmtRate = (rate: number) => (rate >= 10 ? `${Math.round(rate)}/s` : rate >= 0.1 ? `${rate.toFixed(1)}/s` : rate > 0 ? "<0.1/s" : "idle")

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2 || !values.some((v) => v > 0)) return null
  const width = 52
  const height = 18
  const max = Math.max(...values, 1)
  const step = width / (values.length - 1)
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 1 - (v / max) * (height - 3)).toFixed(1)}`).join(" ")
  return (
    <svg width={width} height={height} className="shrink-0 stroke-primary" fill="none" strokeWidth={1.25} aria-hidden="true">
      <polyline points={points} />
    </svg>
  )
}

/** A box that explains its numbers on hover when it has any. */
function StatBox({
  stats,
  windowLabel,
  children,
  ...props
}: React.ComponentProps<"div"> & { stats: HostStats | null; windowLabel: string }) {
  if (!stats || stats.requests === 0) return <div {...props}>{children}</div>
  const { codes } = stats
  return (
    <Tooltip>
      <TooltipTrigger render={<div {...props} />}>{children}</TooltipTrigger>
      <TooltipContent className="flex flex-col gap-0.5">
        <span>{stats.requests.toLocaleString()} requests in the last {windowLabel}</span>
        <span>
          2xx {fmtCount(codes["2xx"])} · 3xx {fmtCount(codes["3xx"])} · 4xx {fmtCount(codes["4xx"])} · 5xx {fmtCount(codes["5xx"])}
        </span>
        <span>
          {fmtRate(stats.rate)} now · avg {Math.round(stats.avgMs)} ms
          {stats.inFlight > 0 && ` · ${stats.inFlight} in flight`}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

const errorShare = (stats: HostStats | null) => (stats && stats.requests > 0 ? stats.codes["5xx"] / stats.requests : 0)

const edgeWidth = (count: number) => clamp(1.25 + Math.sqrt(count) * 1.1, 1.25, 9)

export function RoutesGraph({ sites, query = "" }: { sites: Site[]; query?: string }) {
  const raw = useMemo(() => buildRaw(sites), [sites])
  const base = useMemo(() => arrange(raw, raw.paths), [raw])

  const [manualExpanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [pinned, setPinned] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [isolate, setIsolate] = useState(false)
  const [weighting, setWeighting] = useState<Weighting>("traffic")
  const [windowSeconds, setWindowSeconds] = useState<number>(WINDOWS[0].seconds)
  const win = WINDOWS.find((w) => w.seconds === windowSeconds) ?? WINDOWS[0]
  const metrics = useMetrics(true, windowSeconds)
  const live = metrics?.ok && metrics.enabled && metrics.perHost ? metrics : null
  const byTraffic = weighting === "traffic" && live !== null
  const upstreams = useUpstreamHealth(true)
  const tlsStatus = useTlsStatus(true)
  const siteHosts = (id: string) => raw.hosts.get(id)?.site.hosts ?? []
  const destHealth = (id: string) => {
    const dest = raw.dests.get(id)?.dest
    return dest?.kind === "proxy" ? upstreamHealth(dest.upstreams?.[0] ?? "", upstreams) : null
  }

  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1100)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const focus = hovered ?? pinned
  const touches = (path: Path, id: string) =>
    path.host === id ||
    path.handler === id ||
    path.steps.includes(id) ||
    path.dest === id ||
    base.groupOf.get(path.host)?.id === id ||
    base.groupOf.get(path.dest)?.id === id

  const shownPaths = useMemo(
    () => {
      const found = query
        ? raw.paths.filter((p) =>
            matchesQuery(query, [
              ...hostTexts(raw.hosts.get(p.host)!.site),
              ...chipTexts(raw.handlers.get(p.handler)!.chips),
              ...destTexts(raw.dests.get(p.dest)!.dest),
            ]),
          )
        : raw.paths
      return isolate && pinned ? found.filter((p) => touches(p, pinned)) : found
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [raw, base, isolate, pinned, query],
  )
  const view = useMemo(() => arrange(raw, shownPaths), [raw, shownPaths])

  // While searching, every group that still holds a match is open; clearing the search restores the manual state.
  const expanded = useMemo(
    () =>
      query
        ? new Set([...view.hostGroups, ...view.destGroups].map((group) => group.id))
        : manualExpanded,
    [query, view, manualExpanded],
  )

  const hostStats = useMemo(() => {
    const map = new Map<string, HostStats | null>()
    for (const node of raw.hosts.values()) {
      const found = node.site.hosts.flatMap((host) => (live ? [live.hosts[host.toLowerCase()]] : [])).filter(Boolean)
      map.set(node.id, mergeStats(found))
    }
    return map
  }, [raw, live])
  const groupStats = (group: Group) => mergeStats(group.members.flatMap((id) => hostStats.get(id) ?? []))

  // A site's traffic is split evenly over its routes: Caddy counts per host, not per path.
  const flow = useMemo(() => {
    const perHost = new Map<string, number>()
    for (const path of raw.paths) perHost.set(path.host, (perHost.get(path.host) ?? 0) + 1)
    const weight = (path: Path) => (byTraffic ? (hostStats.get(path.host)?.requests ?? 0) / (perHost.get(path.host) ?? 1) : 1)
    const steps = new Map<string, number>()
    const dests = new Map<string, number>()
    for (const path of shownPaths) {
      for (const id of path.steps) steps.set(id, (steps.get(id) ?? 0) + weight(path))
      dests.set(path.dest, (dests.get(path.dest) ?? 0) + weight(path))
    }
    return { weight, steps, dests }
  }, [raw, shownPaths, hostStats, byTraffic])

  // A group box stands in for its members while it is collapsed.
  const resolve = (id: string) => {
    const group = view.groupOf.get(id)
    return group && group.members.length > 1 && !expanded.has(group.id) ? group.id : id
  }

  /** The nodes a path visits while groups are collapsed: boxes, and waypoints that carry a line past a column. */
  const waypointId = (wp: Waypoint) => `wp:${resolve(wp.from)}>${resolve(wp.to)}@${wp.col}`
  const resolveChain = (chain: string[]) =>
    chain.map((id) => {
      const wp = view.waypoints.get(id)
      return wp ? waypointId(wp) : resolve(id)
    })

  const layout = useMemo(() => {
    const steps = view.middle.length
    const last = steps + 1
    const hostItems = columnItems(view.hostGroups, expanded, HOST_H)
    const destItems = columnItems(view.destGroups, expanded, DEST_H)

    const mean = (ranks: number[]) => ranks.reduce((sum, r) => sum + r, 0) / ranks.length
    const middle = view.middle.map((ids) => {
      const found = new Map<string, { id: string; wp: boolean; height: number; ranks: number[] }>()
      ids.forEach((id, rank) => {
        const wp = view.waypoints.get(id)
        const key = wp ? waypointId(wp) : id
        const item = found.get(key) ?? { id: key, wp: wp !== undefined, height: wp ? WP_H : STEP_H, ranks: [] }
        item.ranks.push(rank)
        found.set(key, item)
      })
      return [...found.values()].sort((a, b) => mean(a.ranks) - mean(b.ranks))
    })

    const heights = [hostItems.map((i) => i.height), ...middle.map((items) => items.map((i) => i.height)), destItems.map((i) => i.height)]
    const total = Math.max(...heights.map(usedHeight), 240)

    const minInner = SIDE_W * 2 + STEP_W * steps + MIN_COL_GAP * last
    const inner = Math.max(width - PAD * 2, minInner)
    const gap = clamp((inner - SIDE_W * 2 - STEP_W * steps) / last, MIN_COL_GAP, 160)
    const side = Math.max(SIDE_W, (inner - gap * last - STEP_W * steps) / 2)
    const widths = [side, ...Array.from({ length: steps }, () => STEP_W), side]
    const colX: number[] = []
    let x = PAD
    for (const w of widths) {
      colX.push(x)
      x += w + gap
    }

    const tops = heights.map((column) => stack(column, total))
    const y = new Map<string, number>()
    const col = new Map<string, number>()
    hostItems.forEach((item, i) => (y.set(item.id, tops[0][i] + item.height / 2), col.set(item.id, 0)))
    middle.forEach((items, k) =>
      items.forEach((item, i) => (y.set(item.id, tops[k + 1][i] + item.height / 2), col.set(item.id, k + 1))),
    )
    destItems.forEach((item, i) => (y.set(item.id, tops[last][i] + item.height / 2), col.set(item.id, last)))

    // A waypoint is a point in the middle of its column; a box has an edge on either side.
    const leftOf = (id: string) => colX[col.get(id) ?? 0] + (id.startsWith("wp:") ? widths[col.get(id) ?? 0] / 2 : 0)
    const rightOf = (id: string) => colX[col.get(id) ?? 0] + widths[col.get(id) ?? 0] / (id.startsWith("wp:") ? 2 : 1)

    const edgeMap = new Map<string, Edge>()
    for (const path of shownPaths) {
      const weight = flow.weight(path)
      const chain = resolveChain(view.chains.get(path) ?? [])
      for (let i = 1; i < chain.length; i++) {
        const from = chain[i - 1]
        const to = chain[i]
        const key = `${from}>${to}`
        const existing = edgeMap.get(key)
        if (existing) {
          existing.count += weight
          continue
        }
        const d = curve(rightOf(from), y.get(from) ?? 0, leftOf(to), y.get(to) ?? 0)
        edgeMap.set(key, { key, from, to, count: weight, d })
      }
    }

    return {
      total,
      last,
      minWidth: minInner + PAD * 2,
      colX,
      widths,
      hostItems,
      destItems,
      middle,
      hostTops: tops[0],
      midTops: tops.slice(1, -1),
      destTops: tops[last],
      edges: [...edgeMap.values()],
      maxWeight: Math.max(...[...edgeMap.values()].map((edge) => edge.count), 1),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, expanded, shownPaths, width, flow])

  // Everything on a path through the focused box lights up; the rest recedes.
  const lit = useMemo(() => {
    if (!focus) return null
    const nodes = new Set<string>()
    const edges = new Set<string>()
    for (const path of shownPaths.filter((p) => touches(p, focus))) {
      for (const id of [path.host, ...path.steps, path.dest]) nodes.add(id)
      const chain = resolveChain(view.chains.get(path) ?? [])
      for (let i = 1; i < chain.length; i++) edges.add(`${chain[i - 1]}>${chain[i]}`)
    }
    return { nodes, edges }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, shownPaths, expanded, view])

  const dimmed = (ids: string[]) => lit !== null && !ids.some((id) => lit.nodes.has(id))
  const toggleGroup = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const allGroups = [...view.hostGroups, ...view.destGroups].filter((group) => group.members.length > 1)
  const allOpen = allGroups.length > 0 && allGroups.every((group) => expanded.has(group.id))
  const toggleAll = () => setExpanded(allOpen ? new Set() : new Set(allGroups.map((group) => group.id)))

  const nodeProps = (id: string) => ({
    role: "button",
    tabIndex: 0,
    onMouseEnter: () => setHovered(id),
    onMouseLeave: () => setHovered(null),
    "data-node-id": id,
    onClick: (event: React.MouseEvent) => {
      event.stopPropagation()
      setPinned(id)
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        setPinned(id)
      }
    },
  })

  const labelOf = (id: string): string => {
    const group = [...base.hostGroups, ...base.destGroups].find((g) => g.id === id)
    if (group) return group.label
    if (id.startsWith("host:")) return hostLabel(raw.hosts.get(id)?.site.hosts[0] ?? id)
    if (id.startsWith("mw:")) return raw.steps.get(id)?.chip.label ?? id
    if (id.startsWith("handler:")) return raw.handlers.get(id)?.chips.map((c) => c.label).join(" + ") || "No middleware"
    return id.replace(/^[a-z]+:/, "")
  }

  // Opening a member of a collapsed group expands the group so the node is visible too.
  const openMember = (id: string) => {
    const group = base.groupOf.get(id)
    if (group) setExpanded((current) => new Set(current).add(group.id))
    setPinned(id)
  }

  const closeDrawer = useCallback(() => {
    setPinned(null)
    setIsolate(false)
  }, [])

  // The drawer shrinks the graph area, so bring the selected node back into view.
  useEffect(() => {
    if (!pinned) return
    const frame = requestAnimationFrame(() => {
      const nodes = containerRef.current?.querySelectorAll<HTMLElement>("[data-node-id]") ?? []
      for (const node of nodes) {
        if (node.dataset.nodeId === pinned) node.scrollIntoView({ block: "nearest", inline: "nearest" })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [pinned])

  const drawerParts = pinned
    ? trafficContributions(raw.paths, (p) => touches(p, pinned), isHostNode(pinned)).map(({ host, fraction }) => ({
        stats: hostStats.get(host) ?? null,
        fraction,
      }))
    : []
  /** Requests per second through the open node; null while there are no live numbers. */
  const drawerRate = live ? (estimateTraffic(drawerParts)?.stats.rate ?? 0) : null

  const cols = layout.colX
  const base_ring = "absolute rounded-md border transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-ring"

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <Button variant="ghost" size="sm" onClick={toggleAll} disabled={allGroups.length === 0}>
          {allOpen ? <ChevronsDownUpIcon data-icon="inline-start" /> : <ChevronsUpDownIcon data-icon="inline-start" />}
          {allOpen ? "Collapse all" : "Expand all"}
        </Button>
        <ToggleGroup
          variant="outline"
          spacing={0}
          aria-label="Line thickness shows"
          value={[byTraffic ? "traffic" : "routes"]}
          onValueChange={(value) => value[0] && setWeighting(value[0] as Weighting)}
        >
          <ToggleGroupItem value="routes" className={PRESSED}>
            Routes
          </ToggleGroupItem>
          <ToggleGroupItem value="traffic" className={PRESSED} disabled={live === null}>
            Traffic
          </ToggleGroupItem>
        </ToggleGroup>
        {live && (
          <>
            <ToggleGroup
              variant="outline"
              spacing={0}
              aria-label="Traffic window"
              value={[String(windowSeconds)]}
              onValueChange={(value) => value[0] && setWindowSeconds(Number(value[0]))}
            >
              {WINDOWS.map((w) => (
                <ToggleGroupItem key={w.seconds} value={String(w.seconds)} className={PRESSED}>
                  {w.short}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-primary" />
              Live · {fmtRate(Object.values(live.hosts).reduce((sum, h) => sum + h.rate, 0))} ·{" "}
              {fmtCount(Object.values(live.hosts).reduce((sum, h) => sum + h.requests, 0))} requests in the last{" "}
              {win.phrase}
              {live.coveredMs < live.windowMs * 0.9 && ` (${fmtSpan(live.coveredMs)} collected so far)`}
            </span>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {pinned ? (
            <>
              <Badge variant="secondary">
                <PinIcon data-icon="inline-start" />
                <span className="max-w-64 truncate">{labelOf(pinned)}</span>
              </Badge>
              <Toggle
                variant="outline"
                size="sm"
                pressed={isolate}
                onPressedChange={setIsolate}
                className={PRESSED}
              >
                Only these paths
              </Toggle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPinned(null)
                  setIsolate(false)
                }}
              >
                <XIcon data-icon="inline-start" />
                Clear
              </Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              Click a box to pin its paths · use the arrow on a group to open it
            </span>
          )}
        </div>
      </div>

      {metrics?.ok && !live && (
        <Alert className="shrink-0 rounded-none border-x-0 border-t-0">
          <InfoIcon />
          <AlertTitle>{metrics.enabled ? "Metrics are on, but not per site" : "Traffic numbers are switched off"}</AlertTitle>
          <AlertDescription>
            Add <code className="font-mono">metrics {"{ per_host }"}</code> to the global options at the top of your
            Caddyfile and deploy. Counters start at zero and fill in live.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex min-h-0 flex-1">
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div ref={containerRef} className="w-full" onClick={() => setPinned(null)}>
          <div className="relative p-4" style={{ minWidth: layout.minWidth }}>
            <div className="relative" style={{ height: layout.total + 32 }}>
              {["Incoming", ...layout.middle.map((_, i) => (layout.middle.length === 1 ? "Middleware" : `Step ${i + 1}`)), "Routed to"].map((title, i) => (
                <div
                  key={title}
                  className="absolute top-0 text-xs font-medium tracking-wide text-muted-foreground uppercase"
                  style={{ left: cols[i] - PAD, width: layout.widths[i] }}
                >
                  {title}
                </div>
              ))}

              <div className="absolute inset-x-0 top-8" style={{ height: layout.total }}>
                <svg className="absolute size-full overflow-visible" style={{ left: -PAD }} aria-hidden="true">
                  {layout.edges.map((edge) => {
                    const on = lit?.edges.has(edge.key)
                    return (
                      <path
                        key={edge.key}
                        d={edge.d}
                        fill="none"
                        className={cn(
                          "transition-[stroke,opacity]",
                          on ? "stroke-primary" : "stroke-muted-foreground",
                          lit ? (on ? "opacity-100" : "opacity-10") : "opacity-30",
                        )}
                        strokeWidth={
                          byTraffic ? 1.25 + 8 * Math.sqrt(edge.count / layout.maxWeight) : edgeWidth(edge.count)
                        }
                      >
                        <title>
                          {byTraffic
                            ? `${fmtCount(edge.count)} requests`
                            : edge.count === 1
                              ? "1 route"
                              : `${edge.count} routes`}
                        </title>
                      </path>
                    )
                  })}
                </svg>

                {layout.hostItems.map((item, i) => {
                  const style = { left: cols[0] - PAD, width: layout.widths[0], top: layout.hostTops[i], height: item.height }
                  if (item.kind === "header") {
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          toggleGroup(item.group.id)
                        }}
                        className="absolute flex items-center gap-1 px-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                        style={style}
                      >
                        <ChevronDownIcon className="size-3.5" />
                        {item.group.label}
                        <span className="font-normal">· {item.group.members.length}</span>
                      </button>
                    )
                  }
                  if (item.kind === "group") {
                    const stats = groupStats(item.group)
                    return (
                      <StatBox
                        stats={stats}
                        windowLabel={win.phrase}
                        key={item.id}
                        {...nodeProps(item.id)}
                        className={cn(
                          base_ring,
                          "flex cursor-pointer flex-col justify-center gap-0.5 bg-card px-3 shadow-[2px_2px_0_var(--border),4px_4px_0_var(--border)]",
                          focus === item.id && "border-primary",
                          dimmed(item.group.members) && "opacity-30",
                        )}
                        style={style}
                      >
                        <div className="flex items-center gap-1.5">
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Open ${item.group.label}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              toggleGroup(item.group.id)
                            }}
                          >
                            <ChevronRightIcon />
                          </Button>
                          <span className="truncate text-sm font-medium">{item.group.label}</span>
                          {item.group.internal && <LockIcon className="size-3 shrink-0 text-muted-foreground" />}
                          <TlsBadge badge={groupBadge(item.group.members.map(siteHosts), tlsStatus)} />
                        </div>
                        <span className="pl-7 text-xs text-muted-foreground">
                          {item.group.members.length} sites
                          {stats && stats.requests > 0 && ` · ${fmtCount(stats.requests)} req`}
                          {stats && stats.rate > 0 && ` · ${fmtRate(stats.rate)}`}
                        </span>
                        {stats && (
                          <div className="absolute top-1/2 right-3 -translate-y-1/2">
                            <Sparkline values={stats.history} />
                          </div>
                        )}
                      </StatBox>
                    )
                  }
                  const node = raw.hosts.get(item.id)
                  if (!node) return null
                  const [primary = "*", ...others] = node.site.hosts
                  const stats = hostStats.get(item.id) ?? null
                  const subtitle = [
                    stats && stats.requests > 0 && `${fmtCount(stats.requests)} req`,
                    stats && stats.rate > 0 && fmtRate(stats.rate),
                    others.length > 0 && `+${others.length} ${others.length === 1 ? "alias" : "aliases"}`,
                    node.routes > 1 && `${node.routes} paths`,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                  return (
                    <StatBox
                      stats={stats}
                      windowLabel={win.phrase}
                      key={item.id}
                      {...nodeProps(item.id)}
                      className={cn(
                        base_ring,
                        "flex cursor-pointer flex-col justify-center gap-0.5 bg-card px-3 shadow-xs",
                        focus === item.id && "border-primary",
                        dimmed([item.id]) && "opacity-30",
                      )}
                      style={style}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{hostLabel(primary)}</span>
                        {isInternal(node.site) && <LockIcon className="size-3 shrink-0 text-muted-foreground" />}
                        <TlsBadge badge={hostBadge(node.site.hosts, tlsStatus)} />
                        {errorShare(stats) > 0.01 && (
                          <span className="size-1.5 shrink-0 rounded-full bg-destructive" title="Some responses were 5xx" />
                        )}
                      </div>
                      {subtitle && <span className="truncate text-xs text-muted-foreground">{subtitle}</span>}
                      {stats && (
                        <div className="absolute top-1/2 right-3 -translate-y-1/2">
                          <Sparkline values={stats.history} />
                        </div>
                      )}
                    </StatBox>
                  )
                })}

                {layout.middle.map((items, k) =>
                  items.map((item, i) => {
                    if (item.wp) return null
                    const chip = raw.steps.get(item.id)?.chip
                    return (
                      <div
                        key={item.id}
                        {...nodeProps(item.id)}
                        className={cn(
                          base_ring,
                          "flex cursor-pointer items-center justify-between gap-2 bg-secondary/50 px-2",
                          focus === item.id && "border-primary",
                          dimmed([item.id]) && "opacity-30",
                        )}
                        style={{ left: cols[k + 1] - PAD, width: layout.widths[k + 1], top: layout.midTops[k][i], height: item.height }}
                      >
                        <span className="line-clamp-2 min-w-0 text-xs leading-snug font-medium" title={chip?.detail ?? chip?.label}>
                          {chip?.label ?? item.id}
                        </span>
                        {byTraffic && (
                          <span className="shrink-0 text-xs text-muted-foreground">{fmtCount(flow.steps.get(item.id) ?? 0)}</span>
                        )}
                      </div>
                    )
                  }),
                )}

                {layout.destItems.map((item, i) => {
                  const style = { left: cols[layout.last] - PAD, width: layout.widths[layout.last], top: layout.destTops[i], height: item.height }
                  if (item.kind === "header") {
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          toggleGroup(item.group.id)
                        }}
                        className="absolute flex items-center gap-1 px-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                        style={style}
                      >
                        <ChevronDownIcon className="size-3.5" />
                        {item.group.label}
                        <span className="font-normal">· {item.group.members.length}</span>
                      </button>
                    )
                  }
                  if (item.kind === "group") {
                    return (
                      <div
                        key={item.id}
                        {...nodeProps(item.id)}
                        className={cn(
                          base_ring,
                          "flex cursor-pointer flex-col justify-center gap-0.5 bg-card px-3 shadow-[2px_2px_0_var(--border),4px_4px_0_var(--border)]",
                          focus === item.id && "border-primary",
                          dimmed(item.group.members) && "opacity-30",
                        )}
                        style={style}
                      >
                        <div className="flex items-center gap-1.5">
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Open ${item.group.label}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              toggleGroup(item.group.id)
                            }}
                          >
                            <ChevronRightIcon />
                          </Button>
                          <span className="truncate font-mono text-sm font-medium">{item.group.label}</span>
                          <HealthDot
                            className="ml-auto"
                            health={worstHealth(item.group.members.map(destHealth))}
                            title="Worst state of the upstreams in this group"
                          />
                        </div>
                        <span className="pl-7 text-xs text-muted-foreground">
                          {item.group.members.length} destinations
                          {byTraffic &&
                            ` · ${fmtCount(item.group.members.reduce((sum, id) => sum + (flow.dests.get(id) ?? 0), 0))} req`}
                        </span>
                      </div>
                    )
                  }
                  const node = raw.dests.get(item.id)
                  if (!node) return null
                  const Icon = DEST_ICONS[node.dest.kind]
                  const label = node.dest.kind === "proxy" ? (node.dest.upstreams?.[0] ?? "") : node.dest.summary
                  return (
                    <div
                      key={item.id}
                      {...nodeProps(item.id)}
                      className={cn(
                        base_ring,
                        "flex cursor-pointer items-center gap-2 bg-card px-3 shadow-xs",
                        focus === item.id && "border-primary",
                        dimmed([item.id]) && "opacity-30",
                      )}
                      style={style}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className={cn("truncate text-sm", node.dest.kind === "proxy" && "font-mono text-xs")}>
                        {label}
                      </span>
                      <HealthDot health={destHealth(item.id)?.health ?? null} />
                      {byTraffic && (
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {fmtCount(flow.dests.get(item.id) ?? 0)} req
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>

      {pinned && (
        <RouteDrawer
          name={labelOf(pinned)}
          kind={nodeKind(pinned)}
          onClose={closeDrawer}
          overview={
            <RouteOverview
              data={{ raw, groups: [...base.hostGroups, ...base.destGroups], destWeights: byTraffic ? flow.dests : null }}
              id={pinned}
              onOpen={openMember}
              health={upstreams}
              rate={drawerRate}
              traffic={
                <TrafficTab
                  metrics={metrics}
                  parts={drawerParts}
                  estimated={!isHostNode(pinned)}
                  windowPhrase={win.phrase}
                />
              }
              tls={<TlsTab name={labelOf(pinned)} kind={nodeKind(pinned)} />}
            />
          }
        />
      )}
      </div>
    </div>
  )
}
