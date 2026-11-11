import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CircleQuestionMarkIcon,
  CornerDownRightIcon,
  FolderIcon,
  InfoIcon,
  MessageSquareIcon,
  PinIcon,
  XIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { GraphCanvas, type CanvasHandle } from "@/features/graph-canvas"
import { useRouter } from "@/hooks/use-router"
import { RouteDrawer } from "@/features/route-drawer"
import { StepNode } from "@/features/step-node"
import { TlsTab } from "@/features/tls-tab"
import { TrafficTab } from "@/features/traffic-tab"
import { RouteOverview } from "@/features/route-overview-view"
import { useMetrics } from "@/hooks/use-metrics"
import { useUpstreamHealth } from "@/hooks/use-upstream-health"
import { HealthDot } from "@/features/health-dot"
import { TlsBadge } from "@/features/tls-badge"
import { TlsLock } from "@/features/tls-lock"
import { useTlsConfig } from "@/hooks/use-tls-config"
import { useTlsStatus } from "@/hooks/use-tls-status"
import { groupBadge, hostBadge } from "@/lib/tls-badges"
import { upstreamHealth, worstHealth } from "@/lib/upstream-health"
import type { Chip, Destination, HostStats, Site } from "@/lib/api"
import { nodeKind } from "@/lib/route-drawer"
import { PANEL_ROWS, PANEL_ROW_H, panelRows, splitMembers } from "@/lib/group-panel"
import { securityOf } from "@/lib/tls-config"
import { stepHeight } from "@/lib/middleware-node"
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
const SIDE_W = 240
const STEP_W = 190
const WP_H = 4
const COL_GAP = 64
const HOST_H = 52
const GROUP_H = 68
const DEST_H = 32
const MIN_GAP = 16

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
  /** Which end the lines sharing this waypoint have in common: the same source, the same target, or neither. */
  shared: "from" | "to" | "none"
}

/** Waypoints are named after the ends they share, so lines that travel together through an empty column merge. */
const waypointKey = (wp: Waypoint, name: (id: string) => string = (id) => id) =>
  `wp:${wp.shared === "to" ? "*" : name(wp.from)}>${wp.shared === "from" ? "*" : name(wp.to)}@${wp.col}`

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
  splitConflicts(raw)
  return raw
}

/**
 * Routes can run the same middleware in a different order (a `route` block keeps the written order, while
 * Caddy sorts everything else). The order most routes agree on wins; on a route that disagrees, the middleware
 * that is out of place gets a second node, so no line runs backwards and no column has to stretch to fit both.
 */
function splitConflicts(raw: Raw) {
  const orders = [...new Set(raw.paths.map((path) => path.steps))]
  const votes = new Map<string, number>()
  for (const steps of orders)
    steps.forEach((a, i) => {
      for (const b of steps.slice(i + 1)) votes.set(`${a}\n${b}`, (votes.get(`${a}\n${b}`) ?? 0) + 1)
    })

  const after = new Map<string, string[]>()
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean =>
    from === to || (!seen.has(from) && seen.add(from) && (after.get(from) ?? []).some((next) => reaches(next, to, seen)))
  for (const [pair] of [...votes].sort((a, b) => b[1] - a[1])) {
    const [a, b] = pair.split("\n")
    if (!reaches(b, a)) after.set(a, [...(after.get(a) ?? []), b])
  }

  const rank = new Map<string, number>()
  const rankOf = (id: string): number => {
    const known = rank.get(id)
    if (known !== undefined) return known
    const value = 1 + Math.max(0, ...[...after].filter(([, next]) => next.includes(id)).map(([from]) => rankOf(from)))
    rank.set(id, value)
    return value
  }

  const fixed = new Map<string[], string[]>()
  for (const steps of orders) {
    let previous = 0
    fixed.set(
      steps,
      steps.map((id) => {
        if (rankOf(id) > previous) {
          previous = rankOf(id)
          return id
        }
        const copy = `${id}~`
        const chip = raw.steps.get(id)?.chip
        if (chip && !raw.steps.has(copy)) raw.steps.set(copy, { id: copy, chip })
        previous += 1
        return copy
      }),
    )
  }
  for (const path of raw.paths) path.steps = fixed.get(path.steps) ?? path.steps
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
  const hops = (path: Path) => {
    const nodes = [path.host, ...path.steps, path.dest]
    const cols = [0, ...path.steps.map((id) => layer.get(id) ?? 1), last]
    return nodes.slice(1).map((to, i) => ({ from: nodes[i], to, start: cols[i], end: cols[i + 1] }))
  }

  // Lines that leave the same box, or arrive at the same one, share a waypoint while they cross a column together.
  const leaving = new Map<string, Set<string>>()
  const arriving = new Map<string, Set<string>>()
  for (const path of paths) {
    for (const { from, to, start, end } of hops(path)) {
      for (let col = start + 1; col < end; col++) {
        leaving.set(`${from}@${col}`, (leaving.get(`${from}@${col}`) ?? new Set()).add(to))
        arriving.set(`${to}@${col}`, (arriving.get(`${to}@${col}`) ?? new Set()).add(from))
      }
    }
  }

  const waypoints = new Map<string, Waypoint>()
  const chains = new Map<Path, string[]>()
  for (const path of paths) {
    const chain = [path.host]
    for (const { from, to, start, end } of hops(path)) {
      for (let col = start + 1; col < end; col++) {
        const out = leaving.get(`${from}@${col}`)?.size ?? 1
        const into = arriving.get(`${to}@${col}`)?.size ?? 1
        const wp: Waypoint = { from, to, col, shared: out > 1 && out >= into ? "from" : into > 1 ? "to" : "none" }
        const id = waypointKey(wp)
        waypoints.set(id, wp)
        chain.push(id)
      }
      chain.push(to)
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
  | { kind: "panel"; id: string; group: Group; height: number; rows: PanelRow[]; centers: number[] }

/** A row of an open group's panel: a member, or the row standing in for the folded ones. */
interface PanelRow {
  id: string
  /** How many members this row stands in for, when it is the "more" row. */
  more?: number
  /** Set on the row that folds a fully shown group back up. */
  fewer?: boolean
  height: number
}

/** A column's boxes top to bottom: a collapsed group is one box, an open one a panel of compact rows. */
function columnItems(groups: Group[], expanded: Set<string>, memberHeight: number, keep: string | null, showAll: Set<string>, rowHeight: number): Item[] {
  return groups.flatMap((group): Item[] => {
    if (group.members.length === 1) return [{ kind: "member", id: group.members[0], height: memberHeight }]
    if (!expanded.has(group.id)) return [{ kind: "group", id: group.id, group, height: GROUP_H }]
    const { shown, hidden } = splitMembers(group.members, keep, showAll.has(group.id))
    const rows: PanelRow[] = shown.map((id) => ({ id, height: rowHeight }))
    if (hidden.length > 0) rows.push({ id: `${group.id}:more`, more: hidden.length, height: PANEL_ROW_H })
    else if (group.members.length > PANEL_ROWS) rows.push({ id: `${group.id}:fewer`, fewer: true, height: PANEL_ROW_H })
    const { centers, height } = panelRows(rows.map((row) => row.height))
    return [{ kind: "panel", id: group.id, group, height, rows, centers }]
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

/** One point per sample, joined by straight segments, so nothing is smoothed away; it stretches to the width it is given. */
function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2 || !values.some((v) => v > 0)) return null
  const height = 16
  const max = Math.max(...values, 1)
  const points = values.map((v, i) => `${i},${(height - 1 - (v / max) * (height - 3)).toFixed(2)}`).join(" ")
  return (
    <svg
      viewBox={`0 0 ${values.length - 1} ${height}`}
      preserveAspectRatio="none"
      className={cn("shrink-0 stroke-primary", className)}
      fill="none"
      strokeWidth={1.25}
      aria-hidden="true"
    >
      <polyline points={points} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  )
}

/** A node's second line: its numbers on the left and the recent history on the right. */
function MetricLine({ text, history, small }: { text: ReactNode; history?: number[]; small?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn("min-w-0 truncate text-muted-foreground", small ? "text-[10px]" : "text-xs")}>{text}</span>
      {history && <Sparkline values={history} className="ml-auto h-4 w-24" />}
    </div>
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

/** Opens or closes a group; sits as a small dot on the bottom border of its node. */
function ExpandDot({ label, onToggle }: { label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
      className="absolute -bottom-2 left-1/2 z-10 flex size-4 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border border-(--node-edge) bg-(--node) text-muted-foreground shadow-xs outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronDownIcon className="size-2.5" />
    </button>
  )
}

/** Half-dots on the sides of a node where its lines attach; only the outer half shows. */
function Ports({ left, right, active, top }: { left?: boolean; right?: boolean; active?: boolean; top?: number }) {
  const tone = active ? "bg-primary" : "bg-(--node-edge)"
  return (
    <>
      {left && (
        <span
          aria-hidden
          className={cn("absolute right-[calc(100%+1px)] h-2.5 w-[5px] -translate-y-1/2 rounded-l-full transition-colors", top === undefined && "top-1/2", tone)}
          style={top === undefined ? undefined : { top }}
        />
      )}
      {right && (
        <span
          aria-hidden
          className={cn("absolute left-[calc(100%+1px)] h-2.5 w-[5px] -translate-y-1/2 rounded-r-full transition-colors", top === undefined && "top-1/2", tone)}
          style={top === undefined ? undefined : { top }}
        />
      )}
    </>
  )
}

/** The sparkline only draws when there is something to show. */
const sparkline = (stats: HostStats | null) => stats !== null && stats.history.length >= 2 && stats.history.some((v) => v > 0)

const errorShare = (stats: HostStats | null) => (stats && stats.requests > 0 ? stats.codes["5xx"] / stats.requests : 0)

/** A host whose responses are failing gets a red tint on its card instead of a marker. */
const failing = (stats: HostStats | null) => errorShare(stats) > 0.01
const FAILING = "border-destructive/50 bg-destructive/10"


/** Lines are solid, so overlaps and joints don't show; this is the grey a faded line would have had over the background. */
const quiet = (percent: number) => `color-mix(in oklab, var(--muted-foreground) ${percent}%, var(--canvas))`

const edgeWidth = (count: number) => clamp(1.25 + Math.sqrt(count) * 1.1, 1.25, 9)

export function RoutesGraph({ sites, query = "" }: { sites: Site[]; query?: string }) {
  const raw = useMemo(() => buildRaw(sites), [sites])
  const base = useMemo(() => arrange(raw, raw.paths), [raw])

  const [manualExpanded, setExpanded] = useState<Set<string>>(() => new Set())
  // The open drawer is kept in the URL (?node=...); a node that no longer exists is ignored.
  const { params, openPanel, replaceParams, closePanel } = useRouter()
  const nodeParam = params.node
  const pinned =
    nodeParam !== undefined &&
    (raw.hosts.has(nodeParam) ||
      raw.handlers.has(nodeParam) ||
      raw.steps.has(nodeParam) ||
      raw.dests.has(nodeParam) ||
      [...base.hostGroups, ...base.destGroups].some((group) => group.id === nodeParam))
      ? nodeParam
      : null
  /** Opening the drawer pushes a history entry, so Back closes it; moving to another node replaces. */
  const setPinned = (id: string | null) => {
    if (id === null) closePanel(["node"])
    else if (nodeParam === undefined) openPanel({ node: id })
    else if (id !== nodeParam) replaceParams({ node: id })
  }
  /** Open groups that show every member instead of folding the rest into a "more" row. */
  const [showAll, setShowAll] = useState<Set<string>>(() => new Set())
  const [hovered, setHovered] = useState<string | null>(null)
  const [isolate, setIsolate] = useState(false)
  const [weighting, setWeighting] = useState<Weighting>("traffic")
  const [windowSeconds, setWindowSeconds] = useState<number>(WINDOWS[0].seconds)
  const win = WINDOWS.find((w) => w.seconds === windowSeconds) ?? WINDOWS[0]
  const metrics = useMetrics(true, windowSeconds)
  const live = metrics?.ok && metrics.enabled && metrics.perHost ? metrics : null
  const byTraffic = weighting === "traffic" && live !== null
  /** Host rows get a second line for traffic when there are live numbers. */
  const hostRowH = live !== null ? 44 : PANEL_ROW_H
  /** Destination rows get a second line for traffic when the lines are weighted by it. */
  const destRowH = byTraffic ? 44 : PANEL_ROW_H
  const upstreams = useUpstreamHealth(true)
  const tlsStatus = useTlsStatus(true)
  const tlsStates = useTlsConfig(true)
  const siteHosts = (id: string) => raw.hosts.get(id)?.site.hosts ?? []
  const destHealth = (id: string) => {
    const dest = raw.dests.get(id)?.dest
    return dest?.kind === "proxy" ? upstreamHealth(dest.upstreams?.[0] ?? "", upstreams) : null
  }

  const containerRef = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<CanvasHandle>(null)

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

  // Members an open group folds into its "more" row, so their lines end there.
  const folded = useMemo(() => {
    const map = new Map<string, string>()
    for (const group of [...view.hostGroups, ...view.destGroups]) {
      if (group.members.length < 2 || !expanded.has(group.id)) continue
      for (const id of splitMembers(group.members, pinned, showAll.has(group.id)).hidden) map.set(id, `${group.id}:more`)
    }
    return map
  }, [view, expanded, pinned, showAll])

  // A group box stands in for its members while it is collapsed, and its "more" row for the folded ones.
  const resolve = (id: string) => {
    const group = view.groupOf.get(id)
    if (group && group.members.length > 1 && !expanded.has(group.id)) return group.id
    return folded.get(id) ?? id
  }

  /** The nodes a path visits while groups are collapsed: boxes, and waypoints that carry a line past a column. */
  const waypointId = (wp: Waypoint) => waypointKey(wp, resolve)
  const resolveChain = (chain: string[]) =>
    chain.map((id) => {
      const wp = view.waypoints.get(id)
      return wp ? waypointId(wp) : resolve(id)
    })

  const layout = useMemo(() => {
    const steps = view.middle.length
    const last = steps + 1
    const hostItems = columnItems(view.hostGroups, expanded, HOST_H, pinned, showAll, hostRowH)
    const destItems = columnItems(view.destGroups, expanded, DEST_H, pinned, showAll, destRowH)

    const mean = (ranks: number[]) => ranks.reduce((sum, r) => sum + r, 0) / ranks.length
    const middle = view.middle.map((ids) => {
      const found = new Map<string, { id: string; wp: boolean; height: number; ranks: number[] }>()
      ids.forEach((id, rank) => {
        const wp = view.waypoints.get(id)
        const key = wp ? waypointId(wp) : id
        const item = found.get(key) ?? { id: key, wp: wp !== undefined, height: wp ? WP_H : stepHeight(raw.steps.get(id)?.chip ?? { label: id }), ranks: [] }
        item.ranks.push(rank)
        found.set(key, item)
      })
      return [...found.values()].sort((a, b) => mean(a.ranks) - mean(b.ranks))
    })

    const heights = [hostItems.map((i) => i.height), ...middle.map((items) => items.map((i) => i.height)), destItems.map((i) => i.height)]
    const total = Math.max(...heights.map(usedHeight), 240)

    // The canvas has a fixed size; zooming and panning fit it to the screen.
    const widths = [SIDE_W, ...Array.from({ length: steps }, () => STEP_W), SIDE_W]
    const colX: number[] = []
    let x = PAD
    for (const w of widths) {
      colX.push(x)
      x += w + COL_GAP
    }

    const tops = heights.map((column) => stack(column, total))
    const y = new Map<string, number>()
    const col = new Map<string, number>()
    const place = (items: Item[], itemTops: number[], column: number) =>
      items.forEach((item, i) => {
        if (item.kind === "panel") {
          item.rows.forEach((row, r) => (y.set(row.id, itemTops[i] + item.centers[r]), col.set(row.id, column)))
        } else {
          y.set(item.id, itemTops[i] + item.height / 2)
          col.set(item.id, column)
        }
      })
    place(hostItems, tops[0], 0)
    middle.forEach((items, k) =>
      items.forEach((item, i) => (y.set(item.id, tops[k + 1][i] + item.height / 2), col.set(item.id, k + 1))),
    )
    place(destItems, tops[last], last)

    // A line that skips a column runs straight through it, at the height of its waypoint.
    const columnOf = (id: string) => col.get(id) ?? 0
    const leftOf = (id: string) => colX[columnOf(id)]
    const rightOf = (id: string) => colX[columnOf(id)] + widths[columnOf(id)]

    const resolved = shownPaths.map((path) => ({ path, chain: resolveChain(view.chains.get(path) ?? []) }))

    // Pull the middle columns towards what they connect to, so lines run straight instead of stepping between columns.
    const neighbours = new Map<string, Set<string>>()
    const touch = (a: string, b: string) => neighbours.set(a, (neighbours.get(a) ?? new Set()).add(b))
    for (const { chain } of resolved) {
      for (let i = 1; i < chain.length; i++) {
        touch(chain[i - 1], chain[i])
        touch(chain[i], chain[i - 1])
      }
    }
    /** The boxes at either end of the stretch of waypoints a waypoint belongs to. */
    const anchors = new Map<string, string[]>()
    const anchorsOf = (waypoint: string) => {
      const known = anchors.get(waypoint)
      if (known) return known
      const seen = new Set([waypoint])
      const ends = new Set<string>()
      for (const id of seen) {
        for (const next of neighbours.get(id) ?? []) {
          if (next.startsWith("wp:")) seen.add(next)
          else ends.add(next)
        }
      }
      anchors.set(waypoint, [...ends])
      return [...ends]
    }
    const average = (ids: string[], fallback: number) => {
      const ys = ids.flatMap((id) => (y.has(id) ? [y.get(id) as number] : []))
      return ys.length ? ys.reduce((sum, v) => sum + v, 0) / ys.length : fallback
    }
    for (let pass = 0; pass < 12; pass++) {
      for (const items of middle) {
        const pos = items.map((item) =>
          average(item.wp ? anchorsOf(item.id) : [...(neighbours.get(item.id) ?? [])], y.get(item.id) ?? 0),
        )
        const apart = (a: number, b: number) => (items[a].height + items[b].height) / 2 + MIN_GAP
        const settle = (forward: boolean) => {
          const order = items.map((_, i) => i)
          if (!forward) order.reverse()
          order.forEach((i, n) => {
            if (n === 0) {
              pos[i] = forward
                ? Math.max(pos[i], items[i].height / 2 + MIN_GAP)
                : Math.min(pos[i], total - items[i].height / 2 - MIN_GAP)
            } else {
              const before = order[n - 1]
              pos[i] = forward ? Math.max(pos[i], pos[before] + apart(before, i)) : Math.min(pos[i], pos[before] - apart(before, i))
            }
          })
        }
        settle(true)
        settle(false)
        settle(true)
        items.forEach((item, i) => y.set(item.id, pos[i]))
      }
    }

    const edgeMap = new Map<string, Edge>()
    for (const { path, chain } of resolved) {
      const weight = flow.weight(path)
      for (let i = 1; i < chain.length; i++) {
        const from = chain[i - 1]
        const to = chain[i]
        const key = `${from}>${to}`
        const existing = edgeMap.get(key)
        if (existing) {
          existing.count += weight
          continue
        }
        const start: [number, number] = [rightOf(from), y.get(from) ?? 0]
        const end: [number, number] = [leftOf(to), y.get(to) ?? 0]
        edgeMap.set(key, { key, from, to, count: weight, d: curve(...start, ...end) })
      }
      // A waypoint's own stretch is drawn once, however many lines leave it.
      for (const id of chain.filter((node) => node.startsWith("wp:"))) {
        const key = `run:${id}`
        const existing = edgeMap.get(key)
        if (existing) {
          existing.count += weight
          continue
        }
        const at = y.get(id) ?? 0
        edgeMap.set(key, { key, from: id, to: id, count: weight, d: `M ${leftOf(id)} ${at} L ${rightOf(id)} ${at}` })
      }
    }

    return {
      total,
      last,
      width: colX[last] + widths[last] + PAD,
      colX,
      widths,
      hostItems,
      destItems,
      middle,
      hostTops: tops[0],
      midTops: middle.map((items) => items.map((item) => (y.get(item.id) ?? 0) - item.height / 2)),
      destTops: tops[last],
      edges: [...edgeMap.values()],
      maxWeight: Math.max(...[...edgeMap.values()].map((edge) => edge.count), 1),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, expanded, shownPaths, flow, folded, pinned, showAll, hostRowH, destRowH])

  const lineWidth = (edge: Edge) =>
    byTraffic ? 1.25 + 8 * Math.sqrt(edge.count / layout.maxWeight) : edgeWidth(edge.count)

  // Everything on a path through the focused box lights up; the rest recedes.
  const lit = useMemo(() => {
    if (!focus) return null
    const nodes = new Set<string>()
    const edges = new Set<string>()
    for (const path of shownPaths.filter((p) => touches(p, focus))) {
      for (const id of [path.host, ...path.steps, path.dest]) nodes.add(id)
      const chain = resolveChain(view.chains.get(path) ?? [])
      for (let i = 1; i < chain.length; i++) edges.add(`${chain[i - 1]}>${chain[i]}`)
      for (const id of chain) if (id.startsWith("wp:")) edges.add(`run:${id}`)
    }
    return { nodes, edges }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, shownPaths, expanded, view, folded])

  const dimmed = (ids: string[]) => lit !== null && !ids.some((id) => lit.nodes.has(id))
  const toggleGroup = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
    setShowAll((current) => {
      if (!current.has(id)) return current
      const next = new Set(current)
      next.delete(id)
      return next
    })
  }
  const setAllShown = (id: string, all: boolean) =>
    setShowAll((current) => {
      const next = new Set(current)
      if (all) next.add(id)
      else next.delete(id)
      return next
    })
  const allGroups = [...view.hostGroups, ...view.destGroups].filter((group) => group.members.length > 1)
  const allOpen = allGroups.length > 0 && allGroups.every((group) => expanded.has(group.id))
  const toggleAll = () => {
    setExpanded(allOpen ? new Set() : new Set(allGroups.map((group) => group.id)))
    if (allOpen) setShowAll(new Set())
  }

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

  const closeDrawer = () => {
    setPinned(null)
    setIsolate(false)
  }

  // The drawer covers the right of the canvas, so pan the selected node out from under it.
  useEffect(() => {
    if (!pinned) return
    const frame = requestAnimationFrame(() => {
      const nodes = containerRef.current?.querySelectorAll<HTMLElement>("[data-node-id]") ?? []
      const drawer = areaRef.current?.querySelector<HTMLElement>("section[aria-label$='details']")
      for (const node of nodes) {
        if (node.dataset.nodeId === pinned) canvasRef.current?.reveal(node, drawer?.offsetWidth ?? 0)
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
  const rowClass =
    "relative flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-(--node-edge) bg-(--node) px-2.5 outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring"
  const base_ring = "absolute rounded-xl border border-(--node-edge) transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-ring"

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
          {pinned && (
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

      <div ref={areaRef} className="relative min-h-0 flex-1">
        <GraphCanvas
          ref={canvasRef}
          width={layout.width}
          height={layout.total + 32}
          fitKey={query}
          onBackgroundClick={() => setPinned(null)}
        >
          <div ref={containerRef} className="relative p-4" style={{ width: layout.width, height: layout.total + 32 }}>
            <div className="relative" style={{ height: layout.total }}>
              <div className="absolute inset-x-0 top-0" style={{ height: layout.total }}>
                <svg className="absolute size-full overflow-visible" style={{ left: -PAD }} aria-hidden="true">
                  {/* SVG paints in document order, so highlighted lines go last to sit on top of the rest. */}
                  {(lit ? [...layout.edges].sort((a, b) => Number(lit.edges.has(a.key)) - Number(lit.edges.has(b.key))) : layout.edges).map((edge) => {
                    const on = lit?.edges.has(edge.key)
                    return (
                      <path
                        key={edge.key}
                        d={edge.d}
                        fill="none"
                        className="transition-[stroke]"
                        style={{ stroke: on ? "var(--primary)" : quiet(lit ? 12 : 42) }}
                        strokeWidth={lineWidth(edge)}
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
                  if (item.kind === "panel") {
                    return (
                      <div
                        key={item.id}
                        className="absolute flex flex-col gap-1 rounded-2xl border border-(--node-edge) bg-foreground/[0.03] p-2"
                        style={style}
                      >
                        <button
                          type="button"
                          aria-label={`Close ${item.group.label}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            toggleGroup(item.group.id)
                          }}
                          className="flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="truncate text-[13px] font-semibold">{item.group.label}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">· {item.group.members.length}</span>
                          <ChevronUpIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
                        </button>
                        {item.rows.map((row) => {
                          if (row.more !== undefined || row.fewer) {
                            return (
                              <button
                                key={row.id}
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  setAllShown(item.group.id, row.more !== undefined)
                                }}
                                className="flex shrink-0 cursor-pointer items-center justify-center gap-1 rounded-lg border border-dashed border-(--node-edge) text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                                style={{ height: PANEL_ROW_H }}
                              >
                                {row.more !== undefined ? <ChevronDownIcon className="size-3" /> : <ChevronUpIcon className="size-3" />}
                                {row.more !== undefined ? `Show ${row.more} more` : "Show fewer"}
                              </button>
                            )
                          }
                        const node = raw.hosts.get(row.id)
                        if (!node) return null
                        const stats = hostStats.get(row.id) ?? null
                        const others = node.site.hosts.length - 1
                        return (
                          <StatBox
                            stats={stats}
                            windowLabel={win.phrase}
                            key={row.id}
                            {...nodeProps(row.id)}
                            className={cn(rowClass, failing(stats) && FAILING, focus === row.id && "border-primary", dimmed([row.id]) && "opacity-30")}
                            style={{ height: row.height }}
                          >
                            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-xs font-medium">{hostLabel(node.site.hosts[0] ?? "*")}</span>
                                {others > 0 && <span className="shrink-0 text-[10px] text-muted-foreground">+{others}</span>}
                                <TlsBadge badge={hostBadge(node.site.hosts, tlsStatus)} />
                                <TlsLock security={securityOf(node.site.hosts, tlsStates)} />
                              </div>
                              {live !== null && (
                                <MetricLine
                                  small
                                  text={
                                    stats && stats.requests > 0
                                      ? `${fmtCount(stats.requests)} req${stats.rate > 0 ? ` · ${fmtRate(stats.rate)}` : ""}`
                                      : "No traffic yet"
                                  }
                                  history={stats?.history}
                                />
                              )}
                            </div>
                          </StatBox>
                        )
                        })}
                        {item.rows.map((row, r) => row.fewer ? null : (
                          <Ports key={row.id} right top={item.centers[r]} active={lit !== null && !dimmed([row.id])} />
                        ))}
                      </div>
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
                          "flex cursor-pointer flex-col justify-center gap-0.5 rounded-2xl bg-(--node) px-3 shadow-(--stack)",
                          item.group.members.some((id) => failing(hostStats.get(id) ?? null)) && FAILING,
                          focus === item.id && "border-primary",
                          dimmed(item.group.members) && "opacity-30",
                        )}
                        style={style}
                      >
                        <Ports right active={lit !== null && !dimmed(item.group.members)} />
                      <div className="flex min-w-0 flex-col gap-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{item.group.label}</span>
                            <TlsBadge badge={groupBadge(item.group.members.map(siteHosts), tlsStatus)} />
                          </div>
                          <MetricLine
                            text={[
                              `${item.group.members.length} sites`,
                              stats && stats.requests > 0 && `${fmtCount(stats.requests)} req`,
                              stats && stats.rate > 0 && fmtRate(stats.rate),
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                            history={stats?.history}
                          />
                        </div>
                        <ExpandDot label={`Open ${item.group.label}`} onToggle={() => toggleGroup(item.group.id)} />
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
                        "flex cursor-pointer flex-col justify-center gap-0.5 bg-(--node) px-3 shadow-xs",
                        failing(stats) && FAILING,
                        focus === item.id && "border-primary",
                        dimmed([item.id]) && "opacity-30",
                      )}
                      style={style}
                    >
                      <Ports right active={lit !== null && !dimmed([item.id])} />
                      <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium">{hostLabel(primary)}</span>
                          <TlsBadge badge={hostBadge(node.site.hosts, tlsStatus)} />
                          <TlsLock security={securityOf(node.site.hosts, tlsStates)} />
                        </div>
                        {(subtitle || sparkline(stats)) && <MetricLine text={subtitle} history={stats?.history} />}
                      </div>
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
                          "flex cursor-pointer flex-col justify-center bg-(--node) px-3 shadow-xs",
                          focus === item.id && "border-primary",
                          dimmed([item.id]) && "opacity-30",
                        )}
                        style={{ left: cols[k + 1] - PAD, width: layout.widths[k + 1], top: layout.midTops[k][i], height: item.height }}
                      >
                        <Ports left right active={lit !== null && !dimmed([item.id])} />
                        <StepNode
                          chip={chip ?? { label: item.id }}
                          available={layout.widths[k + 1] - 24}
                          meta={byTraffic ? fmtCount(flow.steps.get(item.id) ?? 0) : undefined}
                        />
                      </div>
                    )
                  }),
                )}

                {layout.destItems.map((item, i) => {
                  const style = { left: cols[layout.last] - PAD, width: layout.widths[layout.last], top: layout.destTops[i], height: item.height }
                  if (item.kind === "panel") {
                    return (
                      <div
                        key={item.id}
                        className="absolute flex flex-col gap-1 rounded-2xl border border-(--node-edge) bg-foreground/[0.03] p-2"
                        style={style}
                      >
                        <button
                          type="button"
                          aria-label={`Close ${item.group.label}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            toggleGroup(item.group.id)
                          }}
                          className="flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="truncate text-[13px] font-semibold font-mono">{item.group.label}</span>
                          
                          <span className="shrink-0 text-xs text-muted-foreground">· {item.group.members.length}</span>
                          <ChevronUpIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
                        </button>
                        {item.rows.map((row) => {
                          if (row.more !== undefined || row.fewer) {
                            return (
                              <button
                                key={row.id}
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  setAllShown(item.group.id, row.more !== undefined)
                                }}
                                className="flex shrink-0 cursor-pointer items-center justify-center gap-1 rounded-lg border border-dashed border-(--node-edge) text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                                style={{ height: PANEL_ROW_H }}
                              >
                                {row.more !== undefined ? <ChevronDownIcon className="size-3" /> : <ChevronUpIcon className="size-3" />}
                                {row.more !== undefined ? `Show ${row.more} more` : "Show fewer"}
                              </button>
                            )
                          }
                        const node = raw.dests.get(row.id)
                        if (!node) return null
                        const Icon = DEST_ICONS[node.dest.kind]
                        const label = node.dest.kind === "proxy" ? (node.dest.upstreams?.[0] ?? "") : node.dest.summary
                        return (
                          <div
                            key={row.id}
                            {...nodeProps(row.id)}
                            className={cn(rowClass, focus === row.id && "border-primary", dimmed([row.id]) && "opacity-30")}
                            style={{ height: row.height }}
                          >
                            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                              <div className="flex items-center gap-1.5">
                                <span className={cn("truncate text-xs", node.dest.kind === "proxy" && "font-mono text-[11px]")}>{label}</span>
                                <HealthDot health={destHealth(row.id)?.health ?? null} />
                              </div>
                              {byTraffic && (
                                <span className="truncate text-[10px] text-muted-foreground">{fmtCount(flow.dests.get(row.id) ?? 0)} req</span>
                              )}
                            </div>
                          </div>
                        )
                        })}
                        {item.rows.map((row, r) => row.fewer ? null : (
                          <Ports key={row.id} left top={item.centers[r]} active={lit !== null && !dimmed([row.id])} />
                        ))}
                      </div>
                    )
                  }
                  if (item.kind === "group") {
                    return (
                      <div
                        key={item.id}
                        {...nodeProps(item.id)}
                        className={cn(
                          base_ring,
                          "flex cursor-pointer flex-col justify-center gap-0.5 rounded-2xl bg-(--node) px-3 shadow-(--stack)",
                          focus === item.id && "border-primary",
                          dimmed(item.group.members) && "opacity-30",
                        )}
                        style={style}
                      >
                        <Ports left active={lit !== null && !dimmed(item.group.members)} />
                        <div className="flex min-w-0 flex-col gap-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-mono text-sm font-medium">{item.group.label}</span>
                            <HealthDot
                              className="ml-auto"
                              health={worstHealth(item.group.members.map(destHealth))}
                              title="Worst state of the upstreams in this group"
                            />
                          </div>
                          <span className="truncate text-xs text-muted-foreground">
                            {item.group.members.length} destinations
                            {byTraffic &&
                              ` · ${fmtCount(item.group.members.reduce((sum, id) => sum + (flow.dests.get(id) ?? 0), 0))} req`}
                          </span>
                        </div>
                        <ExpandDot label={`Open ${item.group.label}`} onToggle={() => toggleGroup(item.group.id)} />
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
                        "flex cursor-pointer items-center gap-2 bg-(--node) px-3 shadow-xs",
                        focus === item.id && "border-primary",
                        dimmed([item.id]) && "opacity-30",
                      )}
                      style={style}
                    >
                      <Ports left active={lit !== null && !dimmed([item.id])} />
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
        </GraphCanvas>

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
