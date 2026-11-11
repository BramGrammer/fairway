import { useEffect, useMemo, useState, type ReactNode } from "react"
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type Table as TanstackTable,
  type VisibilityState,
} from "@tanstack/react-table"

import { DataTableColumnHeader } from "@/components/data-table/column-header"
import { DataTable } from "@/components/data-table/data-table"
import { DataTableViewOptions } from "@/components/data-table/view-options"
import { DefinitionPopover, DetailText } from "@/components/definition-popover"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Chip, Site } from "@/lib/api"
import {
  collapse,
  destinationLabels,
  destinationSummary,
  flattenSites,
  matcherChips,
  middlewareCount,
  parsePersisted,
  repeatFlags,
  sortKeys,
  type RouteRow,
} from "@/lib/routes-table"
import { cn } from "@/lib/utils"
import { HostAlertBell } from "@/features/host-alerts"
import { DEST_ICONS, HostLink, hostLabel } from "@/features/routes-shared"
import { TimelineStrip } from "@/features/timeline-strip"

const STORAGE_KEY = "fairway.routes-table"

const TITLES: Record<string, string> = {
  host: "Host",
  path: "Path",
  destination: "Destination",
  middleware: "Middleware",
  activity: "Last 24 h",
}

function loadState() {
  try {
    return parsePersisted(localStorage.getItem(STORAGE_KEY))
  } catch {
    return parsePersisted(null)
  }
}

function saveState(sorting: SortingState, visibility: VisibilityState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sorting, visibility }))
  } catch {
    // Storage may be unavailable; the table still works.
  }
}

/** Whether each row repeats the host above it, in the order the table shows them. */
const repeatCache = new WeakMap<object, Map<string, boolean>>()
function repeatsOf(table: TanstackTable<RouteRow>): Map<string, boolean> {
  const rows = table.getRowModel().rows
  let cached = repeatCache.get(rows)
  if (!cached) {
    const flags = repeatFlags(rows.map((row) => row.original.host))
    cached = new Map(rows.map((row, i) => [row.id, flags[i]]))
    repeatCache.set(rows, cached)
  }
  return cached
}

function ChipBadge({ chip }: { chip: Chip }) {
  const badge = (
    <Badge variant="outline" className="max-w-56 min-w-0 shrink font-mono">
      <span className="truncate">{chip.label}</span>
    </Badge>
  )
  if (!chip.detail) return badge
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex min-w-0" />}>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-sm whitespace-pre-wrap">{chip.detail}</TooltipContent>
    </Tooltip>
  )
}

const Muted = ({ children }: { children: string }) => <span className="text-muted-foreground">{children}</span>

function HostCell({ row, repeat }: { row: RouteRow; repeat: boolean }) {
  return (
    <div className="flex items-center gap-1">
      <span className={cn("font-medium", repeat && "font-normal text-muted-foreground")}>
        {hostLabel(row.host)}
        {/* The port reads as part of the name: same line, right behind it, before the link. */}
        {!repeat && row.listen.length > 0 && (
          <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">{row.listen.join(" ")}</span>
        )}
      </span>
      {!repeat && <HostLink host={row.host} />}
    </div>
  )
}

function PathCell({ row, editorText }: { row: RouteRow; editorText: string }) {
  const chips = matcherChips(row.rule)
  if (!row.rule) return <Muted>—</Muted>
  const { shown, more } = collapse(chips)
  return (
    <DefinitionPopover
      label={`Path of ${hostLabel(row.host)}`}
      title={`Path of ${hostLabel(row.host)}`}
      host={row.host}
      editorText={editorText}
      copyText={chips.map((chip) => chip.detail ?? chip.label).join("\n") || undefined}
      fallback={
        chips.length === 0 ? (
          <p className="text-muted-foreground">This route matches all requests.</p>
        ) : (
          <DetailText>{chips.map((chip) => (chip.detail ? `${chip.label}\n${chip.detail}` : chip.label)).join("\n\n")}</DetailText>
        )
      }
    >
      {chips.length === 0 ? (
        <Muted>all requests</Muted>
      ) : (
        <>
          {shown.map((chip) => (
            <ChipBadge key={`${chip.label}|${chip.detail ?? ""}`} chip={chip} />
          ))}
          {more > 0 && <Badge variant="secondary">+{more}</Badge>}
        </>
      )}
    </DefinitionPopover>
  )
}

function DestinationCell({ row, editorText }: { row: RouteRow; editorText: string }) {
  const { first, label, more } = destinationSummary(row.rule)
  if (!first) return <Muted>—</Muted>
  const Icon = DEST_ICONS[first.kind]
  const all = row.rule!.destinations.flatMap((dest) => destinationLabels(dest))
  const list = (
    <ul className="flex flex-col gap-1 font-mono text-xs">
      {all.map((address, i) => (
        <li key={i} className="truncate">
          {address}
        </li>
      ))}
    </ul>
  )
  return (
    <DefinitionPopover
      label={`Destination of ${hostLabel(row.host)}`}
      title={`Destination of ${hostLabel(row.host)}`}
      host={row.host}
      editorText={editorText}
      intro={list}
      copyText={all.join("\n")}
      fallback={null}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <Badge variant={first.kind === "proxy" ? "secondary" : "outline"} className={cn("max-w-64 min-w-0", first.kind === "proxy" && "font-mono")}>
        <span className="truncate">{label}</span>
      </Badge>
      {more > 0 && <Badge variant="secondary">+{more}</Badge>}
    </DefinitionPopover>
  )
}

function ChipList({ chips }: { chips: Chip[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {chips.map((chip, i) => (
        <li key={i} className="flex flex-col">
          <span className="font-mono text-xs">{chip.label}</span>
          {chip.detail && <span className="text-xs whitespace-pre-wrap text-muted-foreground">{chip.detail}</span>}
        </li>
      ))}
    </ul>
  )
}

function MiddlewareCell({ row, editorText }: { row: RouteRow; editorText: string }) {
  const count = middlewareCount(row)
  if (count === 0) return null
  const own = row.rule?.middleware ?? []
  return (
    <DefinitionPopover
      label={`Middleware of ${hostLabel(row.host)}`}
      title={`Middleware of ${hostLabel(row.host)}`}
      host={row.host}
      editorText={editorText}
      fallback={
        <div className="flex max-h-64 flex-col gap-2 overflow-auto">
          {row.siteMiddleware.length > 0 && (
            <section className="flex flex-col gap-1">
              <h4 className="text-xs font-medium text-muted-foreground">Site-wide</h4>
              <ChipList chips={row.siteMiddleware} />
            </section>
          )}
          {own.length > 0 && (
            <section className="flex flex-col gap-1">
              <h4 className="text-xs font-medium text-muted-foreground">This route</h4>
              <ChipList chips={own} />
            </section>
          )}
        </div>
      }
    >
      <Badge variant="outline">{count}</Badge>
    </DefinitionPopover>
  )
}

function ActivityCell({ host }: { host: string }) {
  return (
    <div className="flex h-5 w-40 items-center gap-2">
      {host === "*" ? <span className="size-4" /> : <HostAlertBell host={host} />}
      <TimelineStrip host={host} compact />
    </div>
  )
}

export function RoutesTable({
  sites,
  editorText,
  summary,
}: {
  sites: Site[]
  editorText: string
  /** The "N sites · N routes" line shown at the left of the toolbar. */
  summary?: ReactNode
}) {
  const data = useMemo(() => flattenSites(sites), [sites])
  const [initial] = useState(loadState)
  const [sorting, setSorting] = useState<SortingState>(initial.sorting)
  const [visibility, setVisibility] = useState<VisibilityState>(initial.visibility)

  useEffect(() => saveState(sorting, visibility), [sorting, visibility])

  const columns = useMemo<ColumnDef<RouteRow>[]>(
    () => [
      {
        id: "host",
        accessorFn: sortKeys.host,
        header: ({ column }) => <DataTableColumnHeader column={column} title={TITLES.host} />,
        cell: ({ row, table }) => <HostCell row={row.original} repeat={repeatsOf(table).get(row.id) ?? false} />,
      },
      {
        id: "path",
        accessorFn: sortKeys.path,
        header: ({ column }) => <DataTableColumnHeader column={column} title={TITLES.path} />,
        cell: ({ row }) => <PathCell row={row.original} editorText={editorText} />,
      },
      {
        id: "destination",
        accessorFn: sortKeys.destination,
        header: ({ column }) => <DataTableColumnHeader column={column} title={TITLES.destination} />,
        cell: ({ row }) => <DestinationCell row={row.original} editorText={editorText} />,
      },
      {
        id: "middleware",
        accessorFn: sortKeys.middleware,
        header: ({ column }) => <DataTableColumnHeader column={column} title={TITLES.middleware} />,
        cell: ({ row }) => <MiddlewareCell row={row.original} editorText={editorText} />,
      },
      {
        id: "activity",
        enableSorting: false,
        header: TITLES.activity,
        cell: ({ row }) => <ActivityCell host={row.original.host} />,
      },
    ],
    [editorText],
  )

  // TanStack's table instance is intentionally not memoized.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns,
    getRowId: (row) => row.id,
    state: { sorting, columnVisibility: visibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setVisibility,
    enableSortingRemoval: true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <div className="flex flex-col">
      <div className="flex h-10 items-center justify-between gap-2 border-b px-4">
        {summary}
        <DataTableViewOptions table={table} titles={TITLES} />
      </div>
      <DataTable table={table} empty="No routes." />
    </div>
  )
}
