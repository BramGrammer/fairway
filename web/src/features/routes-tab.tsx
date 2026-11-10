import { useEffect, useMemo, useState } from "react"
import {
  ArrowRightIcon,
  CircleAlertIcon,
  CircleQuestionMarkIcon,
  CornerDownRightIcon,
  ExternalLinkIcon,
  FolderIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  RouteIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"

import { TopBar } from "@/components/top-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  api,
  type Chip,
  type Destination,
  type RoutesReply,
  type Site,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import { PRESSED } from "@/lib/toggle-styles"
import { TimelineStrip } from "@/features/timeline-strip"
import { RoutesGraph } from "@/features/routes-graph"
import { normalizeQuery, siteMatches } from "@/features/routes-filter"

type Source = "running" | "editor"
type Grouping = "graph" | "site" | "upstream"

interface RoutesTabProps {
  /** The editor's current text, shown when the source is "Editor". */
  editorText: string
}

const DEST_ICONS = {
  proxy: ArrowRightIcon,
  file: FolderIcon,
  redirect: CornerDownRightIcon,
  respond: MessageSquareIcon,
  other: CircleQuestionMarkIcon,
} as const

const isDomain = (host: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)

function ChipBadge({ chip }: { chip: Chip }) {
  if (!chip.detail) return <Badge variant="outline">{chip.label}</Badge>
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="outline" />}>{chip.label}</TooltipTrigger>
      <TooltipContent>{chip.detail}</TooltipContent>
    </Tooltip>
  )
}

function Chips({ chips }: { chips: Chip[] }) {
  if (chips.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((chip) => (
        <ChipBadge key={`${chip.label}|${chip.detail ?? ""}`} chip={chip} />
      ))}
    </div>
  )
}

function DestinationView({ dest }: { dest: Destination }) {
  const Icon = DEST_ICONS[dest.kind]
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      {dest.kind === "proxy" ? (
        dest.upstreams?.map((upstream) => (
          <Badge key={upstream} variant="secondary" className="font-mono">
            {upstream}
          </Badge>
        ))
      ) : (
        <span>{dest.summary}</span>
      )}
    </div>
  )
}

function HostLink({ host }: { host: string }) {
  if (!isDomain(host)) return null
  return (
    <a
      href={`https://${host}`}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${host}`}
      className={buttonVariants({ variant: "ghost", size: "icon-xs" })}
    >
      <ExternalLinkIcon />
    </a>
  )
}

const hostLabel = (host: string) => (host === "*" ? "any host" : host)
const matchLabel = (match: string) => match || "all requests"

function SiteTable({ sites }: { sites: Site[] }) {
  // Most middleware is site-wide, so only show this column when some rule has its own.
  const showApplied = sites.some((site) => site.rules.some((rule) => rule.middleware.length > 0))
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Site</TableHead>
          <TableHead>Path</TableHead>
          <TableHead>Destination</TableHead>
          <TableHead>Last 24 h</TableHead>
          {showApplied && <TableHead className="pr-4">Also applied here</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sites.map((site) => {
          const rules = site.rules.length > 0 ? site.rules : [null]
          return rules.map((rule, index) => (
            <TableRow key={`${site.hosts.join(",")}-${site.listen.join(",")}-${index}`}>
              {index === 0 && (
                <TableCell rowSpan={rules.length} className="min-w-64 pl-4 align-top whitespace-normal">
                  <div className="flex flex-col gap-1.5 py-1">
                    {site.hosts.map((host) => (
                      <div key={host} className="flex items-center gap-1">
                        <span className="font-medium">{hostLabel(host)}</span>
                        <HostLink host={host} />
                      </div>
                    ))}
                    <span className="font-mono text-xs text-muted-foreground">{site.listen.join(" ")}</span>
                    <Chips chips={site.middleware} />
                  </div>
                </TableCell>
              )}
              <TableCell className={cn("font-mono text-xs whitespace-normal", !rule?.match && "text-muted-foreground")}>
                {rule ? matchLabel(rule.match) : "—"}
              </TableCell>
              <TableCell className="whitespace-normal">
                {rule ? (
                  <div className="flex flex-col gap-1">
                    {rule.destinations.map((dest, i) => (
                      <DestinationView key={i} dest={dest} />
                    ))}
                  </div>
                ) : (
                  <span className="text-muted-foreground">No destination</span>
                )}
              </TableCell>
              {index === 0 && (
                <TableCell rowSpan={rules.length} className="align-top">
                  <div className="flex flex-col gap-1.5 py-2">
                    {site.hosts.map((host) => (
                      <div key={host} className="flex h-5 items-center">
                        <TimelineStrip host={host} compact />
                      </div>
                    ))}
                  </div>
                </TableCell>
              )}
              {showApplied && (
                <TableCell className="pr-4 whitespace-normal">{rule && <Chips chips={rule.middleware} />}</TableCell>
              )}
            </TableRow>
          ))
        })}
      </TableBody>
    </Table>
  )
}

interface Group {
  key: string
  dest: Destination
  uses: { host: string; match: string }[]
}

/** One group per upstream address (or per other kind of destination), listing who uses it. */
function groupByDestination(sites: Site[]): Group[] {
  const groups = new Map<string, Group>()
  const add = (key: string, dest: Destination, host: string, match: string) => {
    const group = groups.get(key) ?? { key, dest, uses: [] }
    group.uses.push({ host, match })
    groups.set(key, group)
  }
  for (const site of sites) {
    for (const rule of site.rules) {
      for (const dest of rule.destinations) {
        for (const host of site.hosts) {
          if (dest.kind === "proxy") {
            for (const upstream of dest.upstreams ?? []) {
              add(`proxy:${upstream}`, { ...dest, upstreams: [upstream] }, host, rule.match)
            }
          } else {
            add(`${dest.kind}:${dest.summary}`, dest, host, rule.match)
          }
        }
      }
    }
  }
  const rank = (group: Group) => (group.dest.kind === "proxy" ? 0 : 1)
  return [...groups.values()].sort(
    (a, b) => rank(a) - rank(b) || b.uses.length - a.uses.length || a.key.localeCompare(b.key),
  )
}

function UpstreamTable({ sites }: { sites: Site[] }) {
  const groups = useMemo(() => groupByDestination(sites), [sites])
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Destination</TableHead>
          <TableHead>Used by</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => (
          <TableRow key={group.key}>
            <TableCell className="min-w-64 pl-4 align-top whitespace-normal">
              <div className="flex items-center gap-2 py-1">
                <DestinationView dest={group.dest} />
                <Badge variant="outline">{group.uses.length}</Badge>
              </div>
            </TableCell>
            <TableCell className="pr-4 whitespace-normal">
              <div className="flex flex-col gap-1 py-1">
                {group.uses.map((use, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{hostLabel(use.host)}</span>
                    <span className="font-mono text-xs text-muted-foreground">{matchLabel(use.match)}</span>
                  </div>
                ))}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function RoutesTab({ editorText }: RoutesTabProps) {
  const [source, setSource] = useState<Source>("running")
  const [grouping, setGrouping] = useState<Grouping>("graph")
  const [search, setSearch] = useState("")
  const [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState<{ key: string; sites: Site[]; error: string | null } | null>(null)

  const key = `${source}:${refresh}`
  const loading = result?.key !== key

  useEffect(() => {
    let active = true
    api<RoutesReply>("/api/routes", source === "editor" ? { text: editorText } : {})
      .then(({ body }) => {
        if (active) setResult({ key, sites: body.ok ? body.sites : [], error: body.ok ? null : body.error })
      })
      .catch(() => {
        if (active) setResult({ key, sites: [], error: "Cannot reach the editor server." })
      })
    return () => {
      active = false
    }
  }, [key, source, editorText])

  const query = normalizeQuery(search)
  const sites = useMemo(
    () => (result?.sites ?? []).filter((site) => siteMatches(site, query)),
    [result, query]
  )
  const routeCount = sites.reduce((total, site) => total + site.rules.length, 0)
  const upstreamCount = useMemo(
    () => groupByDestination(sites).filter((group) => group.dest.kind === "proxy").length,
    [sites]
  )

  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <InputGroup className="w-64">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            placeholder="Search hosts, upstreams, middleware"
            aria-label="Search routes"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {search && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setSearch("")}>
                <XIcon />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>

        <Separator orientation="vertical" className="mx-1 data-vertical:h-6 data-vertical:self-auto" />

        <ToggleGroup
          variant="outline"
          spacing={0}
          aria-label="Group routes by"
          value={[grouping]}
          onValueChange={(value) => value[0] && setGrouping(value[0] as Grouping)}
        >
          <ToggleGroupItem value="graph" className={PRESSED}>
            Graph
          </ToggleGroupItem>
          <ToggleGroupItem value="site" className={PRESSED}>
            Table
          </ToggleGroupItem>
          <ToggleGroupItem value="upstream" className={PRESSED}>
            By destination
          </ToggleGroupItem>
        </ToggleGroup>

        <ToggleGroup
          variant="outline"
          spacing={0}
          aria-label="Show routes from"
          value={[source]}
          onValueChange={(value) => value[0] && setSource(value[0] as Source)}
        >
          <ToggleGroupItem value="running" className={PRESSED}>
            Running
          </ToggleGroupItem>
          <ToggleGroupItem value="editor" className={PRESSED}>
            Editor
          </ToggleGroupItem>
        </ToggleGroup>

        <Separator orientation="vertical" className="mx-1 data-vertical:h-6 data-vertical:self-auto" />

        <Button variant="ghost" onClick={() => setRefresh((count) => count + 1)} disabled={loading}>
          <RefreshCwIcon data-icon="inline-start" />
          Refresh
        </Button>
      </TopBar>

      {result?.error && (
        <Alert variant="destructive" className="shrink-0 rounded-none border-x-0 border-t-0">
          <CircleAlertIcon />
          <AlertTitle>
            {source === "editor" ? "Caddy cannot read the editor's text" : "Cannot read Caddy's routes"}
          </AlertTitle>
          <AlertDescription className="font-mono text-xs whitespace-pre-wrap">{result.error}</AlertDescription>
        </Alert>
      )}

      {result && !result.error && (
        <div className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground">
          {sites.length} {sites.length === 1 ? "site" : "sites"} · {routeCount}{" "}
          {routeCount === 1 ? "route" : "routes"} · {upstreamCount}{" "}
          {upstreamCount === 1 ? "upstream" : "upstreams"} ·{" "}
          {source === "running" ? "running config" : "unsaved editor text"}
        </div>
      )}

      <div className="min-h-0 flex-1">
        {result === null ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : sites.length === 0 && !result.error ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <RouteIcon />
              </EmptyMedia>
              <EmptyTitle>{query ? "No matching sites" : "No sites"}</EmptyTitle>
              <EmptyDescription>
                {query ? "No host, upstream or middleware matches that search." : "Caddy has no HTTP sites configured."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className={cn("h-full", loading && "opacity-60")}>
            {grouping === "graph" ? (
              <RoutesGraph sites={sites} query={query} />
            ) : (
              <ScrollArea className="h-full">
                {grouping === "site" ? <SiteTable sites={sites} /> : <UpstreamTable sites={sites} />}
              </ScrollArea>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
