import { useEffect, useMemo, useState } from "react"
import {
  CircleAlertIcon,
  FileCodeIcon,
  RefreshCwIcon,
  RouteIcon,
  ServerIcon,
  TableIcon,
  WorkflowIcon,
} from "lucide-react"

import { TopBar } from "@/components/top-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup } from "@/components/ui/toggle-group"
import { SearchField } from "@/components/search-field"
import { ToolbarAction, ToolbarDivider, ToolbarGroupToggle } from "@/components/toolbar-action"
import {
  api,
  type RoutesReply,
  type Site,
} from "@/lib/api"
import { useRouter } from "@/hooks/use-router"
import { cn } from "@/lib/utils"
import { RoutesSummary } from "@/features/routes-summary"
import { RoutesTable } from "@/features/routes-table"
import { RoutesGraph } from "@/features/routes-graph"
import { normalizeQuery, siteMatches } from "@/features/routes-filter"

type Source = "running" | "editor"
type Grouping = "graph" | "site"

const GROUP_PARAM = { graph: undefined, site: "table" } as const

interface RoutesTabProps {
  /** The editor's current text, shown when the source is "Editor". */
  editorText: string
}

/** How many different upstream addresses the sites proxy to. */
function countUpstreams(sites: Site[]): number {
  const upstreams = new Set<string>()
  for (const site of sites)
    for (const rule of site.rules)
      for (const dest of rule.destinations)
        if (dest.kind === "proxy") for (const upstream of dest.upstreams ?? []) upstreams.add(upstream)
  return upstreams.size
}

export function RoutesTab({ editorText }: RoutesTabProps) {
  // View state lives in the URL, so a reload or a pasted link shows the same thing.
  const { params, replaceParams } = useRouter()
  const source: Source = params.source ?? "running"
  const grouping: Grouping = params.group === "table" ? "site" : "graph"
  const search = params.q ?? ""
  const setSource = (value: Source) => replaceParams({ source: value === "editor" ? "editor" : undefined })
  const setGrouping = (value: Grouping) => replaceParams({ group: GROUP_PARAM[value] })
  const setSearch = (value: string) => replaceParams({ q: value })
  const [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState<{ key: string; sites: Site[]; error: string | null } | null>(null)

  const key = `${source}:${refresh}`
  const loading = result?.key !== key

  // The editor's text is only sent, and only watched, when it is the source; it changes with every keystroke.
  const text = source === "editor" ? editorText : null

  useEffect(() => {
    let active = true
    const timer = setTimeout(
      () => {
        api<RoutesReply>("/api/routes", text === null ? {} : { text })
          .then(({ body }) => {
            if (active) setResult({ key, sites: body.ok ? body.sites : [], error: body.ok ? null : body.error })
          })
          .catch(() => {
            if (active) setResult({ key, sites: [], error: "Cannot reach the editor server." })
          })
      },
      text === null ? 0 : 300, // wait for a pause in typing before asking Caddy to adapt the text
    )
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [key, text])

  const query = normalizeQuery(search)
  const sites = useMemo(
    () => (result?.sites ?? []).filter((site) => siteMatches(site, query)),
    [result, query]
  )
  const routeCount = sites.reduce((total, site) => total + site.rules.length, 0)
  const upstreamCount = useMemo(() => countUpstreams(sites), [sites])

  const summary = (
    <RoutesSummary sites={sites.length} routes={routeCount} upstreams={upstreamCount} source={source} />
  )

  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <SearchField
          className="w-64"
          value={search}
          onChange={setSearch}
          placeholder="Search hosts, upstreams, middleware"
          label="Search routes"
        />

        <ToolbarDivider />

        <ToggleGroup
          variant="outline"
          spacing={0}
          aria-label="Group routes by"
          value={[grouping]}
          onValueChange={(value) => value[0] && setGrouping(value[0] as Grouping)}
        >
          <ToolbarGroupToggle value="graph" label="Graph view">
            <WorkflowIcon />
          </ToolbarGroupToggle>
          <ToolbarGroupToggle value="site" label="Table view">
            <TableIcon />
          </ToolbarGroupToggle>
        </ToggleGroup>

        <ToolbarDivider />

        <ToggleGroup
          variant="outline"
          spacing={0}
          aria-label="Show routes from"
          value={[source]}
          onValueChange={(value) => value[0] && setSource(value[0] as Source)}
        >
          <ToolbarGroupToggle value="running" label="Running config">
            <ServerIcon />
          </ToolbarGroupToggle>
          <ToolbarGroupToggle value="editor" label="Editor text, with unsaved changes">
            <FileCodeIcon />
          </ToolbarGroupToggle>
        </ToggleGroup>

        <ToolbarDivider />

        <ToolbarAction
          label="Refresh"
          onClick={() => setRefresh((count) => count + 1)}
          disabled={loading}
        >
          <RefreshCwIcon />
        </ToolbarAction>
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

      {result && !result.error && grouping !== "site" && (
        <div className="flex h-10 shrink-0 items-center border-b px-4">{summary}</div>
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
              <RoutesTable sites={sites} editorText={editorText} summary={summary} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
