import { useEffect, useMemo, useState } from "react"
import { ActivityIcon } from "lucide-react"

import { TopBar } from "@/components/top-bar"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { EventsTable } from "@/features/events-table"
import { api } from "@/lib/api"
import { filterBySubject, subjectLabel, subjectsOf, type EventsReply } from "@/lib/events"

const POLL_MS = 30_000
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
          <EventsTable
            events={shown}
            now={now}
            notice={failed ? "Cannot refresh; showing the last list." : undefined}
          />
        )}
      </div>
    </div>
  )
}
