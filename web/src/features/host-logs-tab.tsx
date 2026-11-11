import { Fragment, useCallback, useContext, useEffect, useRef, useState } from "react"
import { ArrowUpIcon, ChevronRightIcon, InfoIcon, PauseIcon, PlayIcon, ScrollTextIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SearchField } from "@/components/search-field"
import { Spinner } from "@/components/ui/spinner"
import { ToolbarDivider, ToolbarToggle } from "@/components/toolbar-action"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { fetchHostLogs, openHostLogStream, type HostLogLine, type HostLogReply } from "@/lib/api"
import {
  describeLogFailure,
  formatLogRow,
  type StatusTone,
} from "@/lib/host-log-rows"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  expandedDetails,
  filterLines,
  type LogFilter,
  type StatusClass,
} from "@/lib/host-log-filter"
import { LoginRequiredContext } from "@/lib/login-context"
import { newestFirst, visibleRows } from "@/lib/host-log-view"
import { PRESSED } from "@/lib/toggle-styles"
import { cn } from "@/lib/utils"

const BADGE_VARIANT = {
  success: "secondary",
  redirect: "outline",
  "client-error": "default",
  "server-error": "destructive",
  none: "outline",
} as const satisfies Record<StatusTone, "secondary" | "outline" | "default" | "destructive">

const STATUS_CLASSES: StatusClass[] = ["2xx", "3xx", "4xx", "5xx"]

/** Most lines kept in the list; the oldest fall off. */
const MAX_LINES = 500
const RECONNECT_MS = 2000
const RETRY_MS = 5000
/** Scrolled further than this (px) from the top, the reader is taken to be reading and the list holds still. */
const READING_OFFSET = 8

interface Row {
  /** Increases with arrival order, never reused. */
  id: number
  line: HostLogLine
}

interface HostLogState {
  host: string
  reply: HostLogReply
  rows: Row[]
  /** While paused, the id of the last row that was visible when pausing. */
  pausedAfter: number | null
}

/**
 * Loads a host's log, then follows it live. When the stream ends (the host moved to another file, or the
 * connection dropped) the log is read again and the stream reopened. `reply` is null while loading.
 */
function useHostLog(host: string) {
  const [state, setState] = useState<HostLogState | null>(null)
  const [attempt, setAttempt] = useState(0)
  const nextId = useRef(0)

  useEffect(() => {
    let cancelled = false
    let source: EventSource | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const reconnect = () => {
      source?.close()
      source = undefined
      if (!cancelled) timer = setTimeout(() => setAttempt((n) => n + 1), RECONNECT_MS)
    }
    void fetchHostLogs(host).then((reply) => {
      if (cancelled) return
      const rows = reply.ok ? reply.lines.map((line) => ({ id: nextId.current++, line })) : []
      // A reconnect while paused keeps what is on screen; lines written meanwhile are skipped.
      setState((s) => (s && s.host === host && s.pausedAfter !== null && reply.ok ? { ...s, reply } : { host, reply, rows, pausedAfter: null }))
      // A host that cannot be read yet (new `log` block, file not created) is checked again after a while.
      if (!reply.ok) {
        timer = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS)
        return
      }
      source = openHostLogStream(host)
      source.onmessage = (event) => {
        const lines = JSON.parse(event.data) as HostLogLine[]
        const added = lines.map((line) => ({ id: nextId.current++, line }))
        setState((s) => (s && s.host === host ? { ...s, rows: [...s.rows, ...added].slice(-MAX_LINES) } : s))
      }
      source.addEventListener("end", reconnect)
      source.onerror = reconnect
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
      source?.close()
    }
  }, [host, attempt])

  const current = state?.host === host ? state : null
  const setPaused = (paused: boolean) =>
    setState((s) => {
      if (!s) return s
      return { ...s, pausedAfter: paused ? (s.rows.at(-1)?.id ?? -1) : null }
    })
  return { reply: current?.reply ?? null, rows: current?.rows ?? [], pausedAfter: current?.pausedAfter ?? null, setPaused }
}

function PrivacyNote() {
  return (
    <Alert className="shrink-0 rounded-none border-x-0 border-t-0">
      <InfoIcon />
      <AlertTitle>Logs can contain visitor details</AlertTitle>
      <AlertDescription>
        Access logs include visitor addresses and the paths they requested. Fairway has no login, so anyone who can open
        this page can read them.
      </AlertDescription>
    </Alert>
  )
}

function LogTable({ rows }: { rows: Row[] }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  const toggle = (id: number) =>
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  return (
    <table
      data-slot="table"
      className="w-full caption-bottom font-mono text-xs [&_td]:px-1.5 [&_th]:px-1.5 [&_td:first-child]:pl-4 [&_th:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:last-child]:pr-4"
    >
      <TableHeader className="sticky top-0 z-10 bg-background">
        <TableRow>
          <TableHead className="w-6" />
          <TableHead>Time</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Method</TableHead>
          <TableHead>Path</TableHead>
          <TableHead>Client</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead className="text-right">Size</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ id, line }) => {
          const row = formatLogRow(line)
          const expanded = open.has(id)
          return (
            <Fragment key={id}>
              <TableRow
                className={cn("cursor-pointer", row.tone === "server-error" && "bg-destructive/5")}
                onClick={() => toggle(id)}
              >
                <TableCell className="w-6 pr-0">
                  <button
                    type="button"
                    aria-label={expanded ? "Hide details" : "Show details"}
                    aria-expanded={expanded}
                    className="flex text-muted-foreground"
                  >
                    <ChevronRightIcon className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
                  </button>
                </TableCell>
                <TableCell className="text-muted-foreground">{row.time}</TableCell>
                <TableCell>
                  <Badge variant={BADGE_VARIANT[row.tone]} className="-ml-2 font-mono">
                    {row.status}
                  </Badge>
                </TableCell>
                <TableCell>{row.method}</TableCell>
                <TableCell className="max-w-28 truncate" title={row.path}>
                  {row.path}
                </TableCell>
                <TableCell>{row.client}</TableCell>
                <TableCell className="text-right">{row.duration}</TableCell>
                <TableCell className="text-right">{row.size}</TableCell>
              </TableRow>
              {expanded && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={8} className="bg-muted/30">
                    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 whitespace-normal break-all">
                      {expandedDetails(line).map(({ label, value }) => (
                        <Fragment key={label}>
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd>{value}</dd>
                        </Fragment>
                      ))}
                    </dl>
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          )
        })}
      </TableBody>
    </table>
  )
}

function Message({ title, text }: { title: string; text: string }) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ScrollTextIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

/** The recent access log lines of one host. */
export function HostLogsTab({ host }: { host: string }) {
  const { reply, rows, pausedAfter, setPaused } = useHostLog(host)
  const [classes, setClasses] = useState<StatusClass[]>([])
  const [query, setQuery] = useState("")
  const loginRequired = useContext(LoginRequiredContext)
  // The table's scroll viewport, which tells when the reader has scrolled away from the newest lines.
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const areaRef = useCallback(
    (area: HTMLDivElement | null) => setScroller(area?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null),
    [],
  )
  const latestId = useRef(-1)
  useEffect(() => {
    latestId.current = rows.at(-1)?.id ?? -1
  }, [rows])
  // While the reader is scrolled away from the newest lines, new lines are held back so the list stays put.
  const [reading, setReading] = useState<{ host: string; after: number } | null>(null)
  useEffect(() => {
    if (!scroller) return
    const onScroll = () =>
      setReading((current) => (scroller.scrollTop > READING_OFFSET ? (current?.host === host ? current : { host, after: latestId.current }) : null))
    scroller.addEventListener("scroll", onScroll, { passive: true })
    return () => scroller.removeEventListener("scroll", onScroll)
  }, [host, scroller])
  const readingAfter = reading?.host === host ? reading.after : null
  const { shown, held } = visibleRows(rows, pausedAfter ?? readingAfter)
  const unread = pausedAfter === null && readingAfter !== null ? held : 0
  const showNew = () => {
    scroller?.scrollTo({ top: 0 })
    setReading(null)
  }
  const filter: LogFilter = { classes: new Set(classes), query }
  const matching = new Set(filterLines(shown.map((row) => row.line), filter))
  const visible = newestFirst(shown.filter((row) => matching.has(row.line)))
  const filtering = classes.length > 0 || query.trim() !== ""
  const paused = pausedAfter !== null

  const pauseLabel = paused ? (held > 0 ? `Resume (${held} new)` : "Resume the live view") : "Pause the live view"

  let content
  if (reply === null) {
    content = (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Spinner /> Reading the log
      </div>
    )
  } else if (!reply.ok) {
    const { title, text } = describeLogFailure(reply, host)
    content = <Message title={title} text={text} />
  } else {
    content = (
      <>
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <ToggleGroup
            className="shrink-0"
            variant="outline"
            spacing={0}
            multiple
            aria-label="Filter by status"
            value={classes}
            onValueChange={(value) => setClasses(value as StatusClass[])}
          >
            {STATUS_CLASSES.map((c) => (
              <ToggleGroupItem key={c} value={c} className={PRESSED}>
                {c}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <SearchField
            className="min-w-0 flex-1"
            value={query}
            onChange={setQuery}
            placeholder="Search requests"
            label="Search the log"
          />
          <ToolbarDivider />
          <ToolbarToggle label={pauseLabel} pressed={paused} onPressedChange={setPaused}>
            {paused ? <PlayIcon /> : <PauseIcon />}
          </ToolbarToggle>
          {paused && held > 0 && <Badge variant="secondary">{held} new</Badge>}
        </div>
        <div className="relative min-h-0 flex-1">
          {unread > 0 && (
            <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center">
              <Button size="sm" className="pointer-events-auto rounded-full shadow-md" onClick={showNew}>
                <ArrowUpIcon data-icon="inline-start" />
                {unread} new {unread === 1 ? "request" : "requests"}
              </Button>
            </div>
          )}
          {shown.length === 0 ? (
            <Message title="No requests yet" text={`There are no requests for ${host} yet.`} />
          ) : visible.length === 0 && filtering ? (
            <Message title="No matching requests" text="No lines match the current filter." />
          ) : (
            <ScrollArea ref={areaRef} horizontal className="h-full">
              <LogTable rows={visible} />
            </ScrollArea>
          )}
        </div>
        <div className="shrink-0 truncate border-t px-4 py-2 font-mono text-xs text-muted-foreground" title={reply.file}>
          {reply.file}
        </div>
      </>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!loginRequired && <PrivacyNote />}
      {content}
    </div>
  )
}
