import { useEffect, useMemo, useState } from "react"
import { ActivityIcon, ArrowRightIcon, BellIcon, BellOffIcon, SendIcon } from "lucide-react"

import { TopBar } from "@/components/top-bar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useAlertTest } from "@/hooks/use-alert-test"
import { api } from "@/lib/api"
import { formatAge } from "@/lib/age"
import {
  EVENT_STATE_LABELS,
  filterBySubject,
  subjectLabel,
  subjectsOf,
  type Delivery,
  type EventRecord,
  type EventsReply,
  type StateName,
} from "@/lib/events"
import { formatSpan } from "@/lib/timeline"
import { cn } from "@/lib/utils"

const POLL_MS = 30_000
const STATE_DOT: Record<StateName | "unknown", string> = {
  ok: "bg-success",
  warning: "bg-amber-500",
  down: "bg-destructive",
  unknown: "bg-muted-foreground/40",
}
const DELIVERY: Record<Delivery, { label: string; variant: "secondary" | "destructive" | "outline" }> = {
  sent: { label: "Alert sent", variant: "secondary" },
  failed: { label: "Alert failed", variant: "destructive" },
  pending: { label: "Alert pending", variant: "outline" },
}

function StateWord({ state }: { state: StateName | null | undefined }) {
  const key = state ?? "unknown"
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-2 rounded-full", STATE_DOT[key])} />
      {state ? EVENT_STATE_LABELS[state] : "New"}
    </span>
  )
}

function Summary({ event }: { event: EventRecord }) {
  if (event.kind === "state" && event.state) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <StateWord state={event.previous} />
        <ArrowRightIcon className="size-3.5 text-muted-foreground" />
        <StateWord state={event.state} />
      </span>
    )
  }
  if (event.kind === "gap") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className={cn("size-2 rounded-full", STATE_DOT.unknown)} />
        Not watching
        {event.until ? ` for ${formatSpan(event.until - event.at)}` : ""}
      </span>
    )
  }
  return <span>{event.message}</span>
}

function AlertLine({ enabled }: { enabled: boolean | null }) {
  const { testing, result, send } = useAlertTest()

  if (enabled === null) return null
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3 text-sm">
      <span className="inline-flex items-center gap-2 font-medium">
        {enabled ? <BellIcon className="size-4 text-success" /> : <BellOffIcon className="size-4 text-muted-foreground" />}
        {enabled ? "Alerts: on" : "Alerts: off"}
      </span>
      {!enabled && (
        <span className="text-muted-foreground">
          Set <code className="font-mono text-xs">NTFY_URL</code> in the environment and restart to get alerts.
        </span>
      )}
      <Button variant="outline" size="sm" onClick={send} disabled={testing || !enabled} className="ml-auto">
        {testing ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}
        Send test
      </Button>
      {result && (
        <span
          role="status"
          className={cn("basis-full text-xs", result.ok ? "text-success" : "text-destructive")}
        >
          {result.ok ? "Test alert sent." : `Test failed: ${result.error}`}
        </span>
      )}
    </div>
  )
}

/** The global list of what happened lately: state changes, gaps and one-shot events. */
export function EventsTab() {
  const [reply, setReply] = useState<EventsReply | null>(null)
  const [failed, setFailed] = useState(false)
  const [subject, setSubject] = useState("all")
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let stopped = false
    const load = () => {
      if (document.visibilityState === "hidden") return
      api<EventsReply>("/api/events?limit=500", undefined, { background: true })
        .then(({ body }) => {
          if (stopped) return
          setReply(body)
          setFailed(false)
          setNow(Date.now())
        })
        .catch(() => !stopped && setFailed(true))
    }
    load()
    const timer = setInterval(load, POLL_MS)
    document.addEventListener("visibilitychange", load)
    return () => {
      stopped = true
      clearInterval(timer)
      document.removeEventListener("visibilitychange", load)
    }
  }, [])


  const all = useMemo(() => (reply?.ok ? reply.events : []), [reply])
  const subjects = useMemo(() => subjectsOf(all), [all])
  const shown = useMemo(() => filterBySubject(all, subject), [all, subject])
  const items = useMemo(
    () => [{ value: "all", label: "All subjects" }, ...subjects.map((value) => ({ value, label: subjectLabel(value) }))],
    [subjects],
  )

  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <Select items={items} value={subject} onValueChange={(value) => value && setSubject(value)}>
          <SelectTrigger className="w-56" aria-label="Subject">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </TopBar>

      <AlertLine enabled={reply?.ok ? reply.alerts : null} />

      <div className="min-h-0 flex-1">
        {reply === null ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : !reply.ok ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ActivityIcon />
              </EmptyMedia>
              <EmptyTitle>Cannot read events</EmptyTitle>
              <EmptyDescription>{reply.error ?? "The editor server did not answer."}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : shown.length === 0 ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ActivityIcon />
              </EmptyMedia>
              <EmptyTitle>{subject === "all" ? "No events yet" : "No events for this subject"}</EmptyTitle>
              <EmptyDescription>
                {subject === "all"
                  ? "State changes, gaps in watching and failed deploys will appear here."
                  : "Nothing has been recorded for it lately."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="h-full">
            {failed && (
              <p className="px-4 pt-3 text-xs text-muted-foreground">Cannot refresh; showing the last list.</p>
            )}
            <ul className="divide-y">
              {shown.map((event) => (
                <li key={event.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                  <span
                    className="w-20 shrink-0 text-xs text-muted-foreground"
                    title={new Date(event.at).toLocaleString()}
                  >
                    {formatAge(event.at, now)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <Summary event={event} />
                    {event.subject && (
                      <span className="ml-3 font-mono text-xs text-muted-foreground">{subjectLabel(event.subject)}</span>
                    )}
                  </span>
                  {event.delivery && (
                    <Badge variant={DELIVERY[event.delivery].variant}>{DELIVERY[event.delivery].label}</Badge>
                  )}
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </div>
    </div>
  )
}
