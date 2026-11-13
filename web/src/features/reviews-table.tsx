import { useEffect, useMemo, useState } from "react"
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table"

import { DataTableColumnHeader } from "@/components/data-table/column-header"
import { DataTable } from "@/components/data-table/data-table"
import { DataTableViewOptions } from "@/components/data-table/view-options"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { formatAge } from "@/lib/age"
import {
  countByLevel,
  DEFAULT_SORTING,
  formatTokens,
  LEVEL_LABELS,
  LEVELS,
  parsePersistedReviews,
  periodLabel,
  sortKeys,
  STATUS_LABELS,
  totalTokens,
  type Level,
  type Review,
} from "@/lib/reviews"
import { loadTableState, saveTableState } from "@/lib/table-state"

const STORAGE_KEY = "fairway.reviews-table"

const TITLES: Record<string, string> = {
  started: "Started",
  period: "Period",
  observations: "Observations",
  tokens: "Tokens",
  status: "Status",
}

export const LEVEL_VARIANT: Record<Level, "destructive" | "warning" | "secondary"> = {
  urgent: "destructive",
  notable: "warning",
  info: "secondary",
}

const STATUS_VARIANT = { running: "outline", done: "secondary", failed: "destructive" } as const

/** Observations per level as small badges; levels without any are left out. */
export function LevelBadges({ review }: { review: Review }) {
  const counts = countByLevel(review.observations)
  if (review.status === "running") return <span className="text-muted-foreground">–</span>
  const shown = LEVELS.filter((level) => counts[level] > 0)
  if (shown.length === 0) return <span className="text-muted-foreground">{review.status === "done" ? "None" : "–"}</span>
  return (
    <span className="inline-flex items-center gap-1">
      {shown.map((level) => (
        <Badge key={level} variant={LEVEL_VARIANT[level]} title={LEVEL_LABELS[level]}>
          {counts[level]} {LEVEL_LABELS[level].toLowerCase()}
        </Badge>
      ))}
    </span>
  )
}

export function StatusBadge({ status }: { status: Review["status"] }) {
  return (
    <Badge variant={STATUS_VARIANT[status]}>
      {status === "running" && <Spinner className="size-3" />}
      {STATUS_LABELS[status]}
    </Badge>
  )
}

/** The Reviews as a data table: when each started, the period it covers, what it found, and what it cost. */
export function ReviewsTable({
  reviews,
  now,
  notice,
  onOpen,
}: {
  reviews: Review[]
  now: number
  notice?: string
  onOpen: (review: Review) => void
}) {
  const [initial] = useState(() => loadTableState(STORAGE_KEY, parsePersistedReviews))
  const [sorting, setSorting] = useState<SortingState>(initial.sorting.length > 0 ? initial.sorting : DEFAULT_SORTING)
  const [visibility, setVisibility] = useState<VisibilityState>(initial.visibility)

  useEffect(() => saveTableState(STORAGE_KEY, sorting, visibility), [sorting, visibility])

  const columns = useMemo<ColumnDef<Review>[]>(
    () => [
      {
        id: "started",
        accessorFn: sortKeys.started,
        header: ({ column }) => <DataTableColumnHeader column={column} title={TITLES.started} />,
        cell: ({ row }) => (
          <button type="button" className="text-left hover:underline" title={new Date(row.original.startedAt).toLocaleString()} onClick={() => onOpen(row.original)}>
            {formatAge(row.original.startedAt, now)}
          </button>
        ),
      },
      {
        id: "period",
        accessorFn: sortKeys.period,
        header: ({ column }) => <DataTableColumnHeader column={column} title={TITLES.period} />,
        cell: ({ row }) => <span className="text-muted-foreground">{periodLabel(row.original.period)}</span>,
      },
      {
        id: "observations",
        accessorFn: sortKeys.observations,
        header: ({ column }) => <DataTableColumnHeader column={column} title={TITLES.observations} />,
        cell: ({ row }) => <LevelBadges review={row.original} />,
      },
      {
        id: "tokens",
        accessorFn: sortKeys.tokens,
        header: ({ column }) => <DataTableColumnHeader column={column} title={TITLES.tokens} />,
        cell: ({ row }) => {
          const total = totalTokens(row.original.usage)
          const { usage } = row.original
          return total === null || !usage ? (
            <span className="text-muted-foreground">–</span>
          ) : (
            <span className="tabular-nums" title={`${formatTokens(usage.promptTokens)} read, ${formatTokens(usage.completionTokens)} written`}>
              {formatTokens(total)}
            </span>
          )
        },
      },
      {
        id: "status",
        accessorFn: sortKeys.status,
        header: ({ column }) => <DataTableColumnHeader column={column} title={TITLES.status} />,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
    ],
    [now, onOpen],
  )

  // TanStack's table instance is intentionally not memoized.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: reviews,
    columns,
    getRowId: (review) => String(review.id),
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
            <span className="font-medium text-foreground tabular-nums">{reviews.length}</span>
            {reviews.length === 1 ? "review" : "reviews"}
          </Badge>
          {notice && <span className="text-xs text-muted-foreground">{notice}</span>}
        </div>
        <DataTableViewOptions table={table} titles={TITLES} />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <DataTable table={table} empty="No reviews." onRowClick={onOpen} />
      </ScrollArea>
    </div>
  )
}
