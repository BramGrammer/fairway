import { useEffect, useMemo, useState } from "react"
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table"
import { ArrowRightIcon } from "lucide-react"

import { DataTableColumnHeader } from "@/components/data-table/column-header"
import { DataTable } from "@/components/data-table/data-table"
import { DataTableViewOptions } from "@/components/data-table/view-options"
import { useRouter } from "@/hooks/use-router"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { formatAge } from "@/lib/age"
import { EVENT_STATE_LABELS, type Delivery, type EventRecord, type StateName } from "@/lib/events"
import {
  clockLabel,
  DEFAULT_SORTING,
  eventName,
  eventType,
  parsePersistedEvents,
  sortKeys,
  TYPE_LABELS,
} from "@/lib/events-table"
import { loadTableState, saveTableState } from "@/lib/table-state"
import { formatSpan } from "@/lib/timeline"

const STORAGE_KEY = "fairway.events-table"

const TITLES: Record<string, string> = {
  time: "Time",
  type: "Type",
  name: "Name",
  status: "Status change",
  alert: "Alert",
}

const DELIVERY: Record<Delivery, { label: string; variant: "secondary" | "destructive" | "outline" }> = {
  sent: { label: "Sent", variant: "secondary" },
  failed: { label: "Failed", variant: "destructive" },
  pending: { label: "Pending", variant: "outline" },
}

const STATE_VARIANT: Record<StateName, "success" | "warning" | "destructive"> = {
  ok: "success",
  warning: "warning",
  down: "destructive",
}

/** A State as a tinted badge; no State at all means the Subject was new or is no longer watched. */
function StateBadge({ state }: { state: StateName | null | undefined }) {
  return state ? (
    <Badge variant={STATE_VARIANT[state]}>{EVENT_STATE_LABELS[state]}</Badge>
  ) : (
    <Badge variant="secondary">New</Badge>
  )
}

function StatusCell({ event }: { event: EventRecord }) {
  if (event.kind === "state" && event.state) {
    return (
      <span className="inline-flex items-center gap-2">
        <StateBadge state={event.previous} />
        <ArrowRightIcon className="size-3.5 text-muted-foreground" />
        <StateBadge state={event.state} />
      </span>
    )
  }
  if (event.kind === "gap") {
    return (
      <span className="text-muted-foreground">
        Not watching{event.until ? ` for ${formatSpan(event.until - event.at)}` : ""}
      </span>
    )
  }
  return (
    <span className="block max-w-lg truncate" title={event.message}>
      {event.message}
    </span>
  )
}

/** A link to the Review an Event is about. */
function ReviewLink({ id, children }: { id: number; children: React.ReactNode }) {
  const { linkProps } = useRouter()
  return (
    <a className="text-xs underline-offset-2 hover:underline" {...linkProps("reviews", { review: String(id) })}>
      {children}
    </a>
  )
}

/** The list of events as a data table: when, what kind, which one, and what changed. */
export function EventsTable({ events, now, notice }: { events: EventRecord[]; now: number; notice?: string }) {
  const [initial] = useState(() => loadTableState(STORAGE_KEY, parsePersistedEvents))
  const [sorting, setSorting] = useState<SortingState>(initial.sorting.length > 0 ? initial.sorting : DEFAULT_SORTING)
  const [visibility, setVisibility] = useState<VisibilityState>(initial.visibility)

  useEffect(() => saveTableState(STORAGE_KEY, sorting, visibility), [sorting, visibility])

  const columns = useMemo<ColumnDef<EventRecord>[]>(
    () => [
      {
        id: "time",
        accessorFn: sortKeys.time,
        header: ({ column }) => <DataTableColumnHeader column={column} title={TITLES.time} />,
        // How long ago it was; the time of day takes its place while the row is hovered. Both sit in the
        // same spot, so the column keeps its width.
        cell: ({ row }) => (
          <span className="inline-grid" title={new Date(row.original.at).toLocaleString()}>
            <span className="col-start-1 row-start-1 group-hover/row:invisible">{formatAge(row.original.at, now)}</span>
            <span className="invisible col-start-1 row-start-1 group-hover/row:visible">
              {clockLabel(row.original.at, now)}
            </span>
          </span>
        ),
      },
      {
        id: "type",
        accessorFn: sortKeys.type,
        header: ({ column }) => <DataTableColumnHeader column={column} title={TITLES.type} />,
        cell: ({ row }) => <Badge variant="outline">{TYPE_LABELS[eventType(row.original)]}</Badge>,
      },
      {
        id: "name",
        accessorFn: sortKeys.name,
        header: ({ column }) => <DataTableColumnHeader column={column} title={TITLES.name} />,
        cell: ({ row }) => {
          const name = eventName(row.original)
          return row.original.review ? (
            <ReviewLink id={row.original.review.id}>{name}</ReviewLink>
          ) : name ? <span className="font-mono text-xs">{name}</span> : <span className="text-muted-foreground">–</span>
        },
      },
      {
        id: "status",
        accessorFn: sortKeys.status,
        header: ({ column }) => <DataTableColumnHeader column={column} title={TITLES.status} />,
        cell: ({ row }) => <StatusCell event={row.original} />,
      },
      {
        id: "alert",
        accessorFn: sortKeys.alert,
        header: ({ column }) => <DataTableColumnHeader column={column} title={TITLES.alert} />,
        cell: ({ row }) => {
          const delivery = row.original.delivery
          return delivery ? <Badge variant={DELIVERY[delivery].variant}>{DELIVERY[delivery].label}</Badge> : null
        },
      },
    ],
    [now],
  )

  // TanStack's table instance is intentionally not memoized.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: events,
    columns,
    getRowId: (event) => String(event.id),
    state: { sorting, columnVisibility: visibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setVisibility,
    enableSortingRemoval: true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b px-4">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
            <span className="font-medium text-foreground tabular-nums">{events.length}</span>
            {events.length === 1 ? "event" : "events"}
          </Badge>
          {notice && <span className="text-xs text-muted-foreground">{notice}</span>}
        </div>
        <DataTableViewOptions table={table} titles={TITLES} />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <DataTable table={table} empty="No events." />
      </ScrollArea>
    </div>
  )
}
