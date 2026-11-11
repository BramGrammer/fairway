import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowDownToLineIcon,
  PauseIcon,
  ScrollTextIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react"

import { ToolbarAction, ToolbarToggle } from "@/components/toolbar-action"
import { TopBar } from "@/components/top-bar"
import { Badge } from "@/components/ui/badge"
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
  InputGroupInput,
} from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api, openStream } from "@/lib/api"
import { PRESSED } from "@/lib/toggle-styles"
import { cn } from "@/lib/utils"

interface LogEntry {
  id: number
  raw: string
  time: string
  level: string
  status: number | null
  text: string
}

const MAX_ENTRIES = 2000
const MAX_SHOWN = 1000
const LEVELS = [
  { value: "all", label: "All levels" },
  { value: "warn", label: "Warnings and errors" },
  { value: "error", label: "Errors only" },
]

let nextId = 0

/** The editor's own status check calls Caddy's admin API every few seconds; hide those lines. */
const EDITOR_NOISE = /"logger":"admin\.api","msg":"received request"/
const parseAll = (lines: string[]) => lines.filter((line) => !EDITOR_NOISE.test(line)).map(parse)

function parse(raw: string): LogEntry {
  const id = nextId++
  try {
    const log = JSON.parse(raw)
    const time =
      typeof log.ts === "number" ? new Date(log.ts * 1000).toLocaleTimeString() : ""
    const level = String(log.level ?? "info")
    if (log.request) {
      const { method, host, uri } = log.request
      const ms = typeof log.duration === "number" ? ` · ${Math.round(log.duration * 1000)} ms` : ""
      return {
        id, raw, time, level,
        status: typeof log.status === "number" ? log.status : null,
        text: `${method} ${host}${uri}${ms}`,
      }
    }
    const logger = log.logger ? `[${log.logger}] ` : ""
    const error = log.error ? ` — ${log.error}` : ""
    return { id, raw, time, level, status: null, text: `${logger}${log.msg ?? raw}${error}` }
  } catch {
    return { id, raw, time: "", level: "info", status: null, text: raw }
  }
}

function pretty(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function isProblem(entry: LogEntry) {
  return entry.level === "error" || entry.level === "fatal" || entry.level === "warn"
}

function StatusBadge({ entry }: { entry: LogEntry }) {
  if (entry.status !== null) {
    const variant =
      entry.status >= 500 ? "destructive" : entry.status >= 400 ? "default" : entry.status >= 300 ? "outline" : "secondary"
    return <Badge variant={variant} className="w-12 justify-center font-mono">{entry.status}</Badge>
  }
  const variant = entry.level === "error" || entry.level === "fatal" ? "destructive" : entry.level === "warn" ? "default" : "outline"
  return <Badge variant={variant} className="w-12 justify-center">{entry.level}</Badge>
}

/** A thin vertical line between the groups of the top bar. */
function Divider() {
  return <Separator orientation="vertical" className="mx-1 data-vertical:h-6 data-vertical:self-auto" />
}

/** `active` is true while the tab is visible; the panel stays mounted so the stream keeps running. */
export function LogsTab({ active }: { active: boolean }) {
  const [entries, setEntries] = useState<LogEntry[] | null>(null)
  const [paused, setPaused] = useState(false)
  const [follow, setFollow] = useState(true)
  const [search, setSearch] = useState("")
  const [level, setLevel] = useState("all")
  const [statusClass, setStatusClass] = useState("")
  const [open, setOpen] = useState<number | null>(null)
  const pending = useRef<LogEntry[]>([])
  const pausedRef = useRef(paused)
  useEffect(() => {
    pausedRef.current = paused
  }, [paused])
  const area = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let source: EventSource | undefined
    let cancelled = false
    void api<{ lines: string[] }>("/api/logs?lines=500").then(({ body }) => {
      if (cancelled) return
      setEntries(parseAll(body.lines))
      source = openStream("/api/logs/stream")
      source.onmessage = (event) => {
        const incoming = parseAll(JSON.parse(event.data) as string[])
        if (pausedRef.current) pending.current.push(...incoming)
        else setEntries((current) => [...(current ?? []), ...incoming].slice(-MAX_ENTRIES))
      }
    })
    return () => {
      cancelled = true
      source?.close()
    }
  }, [])

  const shown = useMemo(() => {
    const query = search.trim().toLowerCase()
    return (entries ?? [])
      .filter((entry) => {
        if (level === "error" && entry.level !== "error" && entry.level !== "fatal") return false
        if (level === "warn" && !isProblem(entry)) return false
        if (statusClass && String(entry.status ?? "")[0] !== statusClass) return false
        return !query || entry.raw.toLowerCase().includes(query)
      })
      .slice(-MAX_SHOWN)
  }, [entries, search, level, statusClass])

  useEffect(() => {
    if (!follow || !active) return
    const viewport = area.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [shown, follow, active])

  function setPausedTo(next: boolean) {
    if (!next && pending.current.length > 0) {
      const flushed = pending.current
      pending.current = []
      setEntries((current) => [...(current ?? []), ...flushed].slice(-MAX_ENTRIES))
    }
    setPaused(next)
  }

  return (
    <div className="flex h-full flex-col">
      {active && (
        <TopBar>
          <div className="flex items-center gap-2">
            <InputGroup className="w-48">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                placeholder="Search logs"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </InputGroup>
            <Divider />
            <Select items={LEVELS} value={level} onValueChange={(value) => value && setLevel(value)}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {LEVELS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Divider />
            <ToggleGroup
              variant="outline"
              spacing={0}
              aria-label="Filter by status"
              value={[statusClass || "all"]}
              onValueChange={(value) =>
                setStatusClass(value[0] && value[0] !== "all" ? value[0] : "")
              }
            >
              <ToggleGroupItem value="all" className={PRESSED}>All</ToggleGroupItem>
              <ToggleGroupItem value="2" className={PRESSED}>2xx</ToggleGroupItem>
              <ToggleGroupItem value="3" className={PRESSED}>3xx</ToggleGroupItem>
              <ToggleGroupItem value="4" className={PRESSED}>4xx</ToggleGroupItem>
              <ToggleGroupItem value="5" className={PRESSED}>5xx</ToggleGroupItem>
            </ToggleGroup>
          </div>

          <Divider />

          <div className="flex items-center gap-1">
            <ToolbarToggle
              label={paused ? "Resume the live stream" : "Pause the live stream"}
              pressed={paused}
              onPressedChange={setPausedTo}
            >
              <PauseIcon />
            </ToolbarToggle>
            <ToolbarToggle label="Follow new entries" pressed={follow} onPressedChange={setFollow}>
              <ArrowDownToLineIcon />
            </ToolbarToggle>
          </div>

          <Divider />

          <ToolbarAction
            label="Clear the list"
            onClick={() => {
              setEntries([])
              pending.current = []
            }}
          >
            <Trash2Icon />
          </ToolbarAction>
        </TopBar>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {entries === null || shown.length === 0 ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ScrollTextIcon />
              </EmptyMedia>
              <EmptyTitle>{entries === null ? "Loading logs" : "No log entries"}</EmptyTitle>
              <EmptyDescription>
                {entries === null
                  ? "Reading Caddy's log file."
                  : "Nothing matches the current filters yet. New requests appear here live."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea ref={area} className="h-full">
            {shown.map((entry) => (
              <div key={entry.id} className="border-b last:border-b-0">
                <button
                  type="button"
                  onClick={() => setOpen(open === entry.id ? null : entry.id)}
                  className={cn(
                    "grid w-full grid-cols-[5.5rem_3.5rem_1fr] items-center gap-3 px-3 py-1.5 text-left font-mono text-xs hover:bg-muted/50",
                    isProblem(entry) && "bg-destructive/5"
                  )}
                >
                  <span className="text-muted-foreground">{entry.time}</span>
                  <StatusBadge entry={entry} />
                  <span className="truncate">{entry.text}</span>
                </button>
                {open === entry.id && (
                  <pre className="overflow-x-auto bg-muted/40 px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap text-muted-foreground">
                    {pretty(entry.raw)}
                  </pre>
                )}
              </div>
            ))}
          </ScrollArea>
        )}
      </div>
    </div>
  )
}
