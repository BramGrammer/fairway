import { useCallback, useEffect, useMemo, useState } from "react"
import { ClipboardCheckIcon, PlayIcon } from "lucide-react"

import { TopBar, TopBarTitle } from "@/components/top-bar"
import { ToolbarAction } from "@/components/toolbar-action"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { ReviewDrawer } from "@/features/review-drawer"
import { ReviewsTable } from "@/features/reviews-table"
import { useRouter } from "@/hooks/use-router"
import { api, type RoutesReply, type Site } from "@/lib/api"
import { nextReviewLabel, type Review, type ReviewsReply, type StartReviewReply } from "@/lib/reviews"

/** How often the list is read: quickly while a Review runs, slowly otherwise. */
const RUNNING_POLL_MS = 3_000
const IDLE_POLL_MS = 30_000

/** The Sites of the running config, read while a Review is open so that its Observations can link to their Logs. */
function useRunningSites(wanted: boolean): Site[] | null {
  const [sites, setSites] = useState<Site[] | null>(null)
  useEffect(() => {
    if (!wanted) return
    let stopped = false
    // The routes endpoint is a POST: an empty body asks for the running config.
    api<RoutesReply>("/api/routes", {}, { background: true })
      .then(({ body }) => !stopped && setSites(body.ok ? body.sites : null))
      .catch(() => undefined)
    return () => {
      stopped = true
    }
  }, [wanted])
  return sites
}

/** The Reviews: a button that runs one now, and the list of what they found. */
export function ReviewsTab({ onAskAssistant }: { /** Offered when the Assistant is available: asks it for a Proposal that fixes what a Review found. */ onAskAssistant?: (message: string) => void }) {
  const { params, openPanel, closePanel } = useRouter()
  const [reply, setReply] = useState<ReviewsReply | null>(null)
  const [failed, setFailed] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const running = reply?.ok === true && reply.running

  const load = useCallback(async (background: boolean) => {
    try {
      const { body } = await api<ReviewsReply>("/api/reviews", undefined, { background })
      setReply(body)
      setFailed(false)
      setNow(Date.now())
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    let stopped = false
    const tick = () => {
      if (stopped || document.visibilityState === "hidden") return
      void load(true)
    }
    const timer = setTimeout(tick, 0)
    const interval = setInterval(tick, running ? RUNNING_POLL_MS : IDLE_POLL_MS)
    document.addEventListener("visibilitychange", tick)
    return () => {
      stopped = true
      clearTimeout(timer)
      clearInterval(interval)
      document.removeEventListener("visibilitychange", tick)
    }
  }, [load, running])

  const start = async () => {
    setStarting(true)
    setStartError(null)
    try {
      const { body } = await api<StartReviewReply>("/api/reviews", {})
      if (!body.ok) setStartError(body.error ?? "The Review could not be started.")
    } catch {
      setStartError("Cannot reach the editor server.")
    }
    await load(false)
    setStarting(false)
  }

  const reviews = useMemo(() => (reply?.ok ? reply.reviews : []), [reply])
  const open = params.review ? reviews.find((review) => String(review.id) === params.review) : undefined
  const sites = useRunningSites(open !== undefined)
  const onOpen = useCallback((review: Review) => openPanel({ review: String(review.id) }), [openPanel])

  return (
    <div className="flex h-full flex-col">
      <TopBarTitle>
        {running && (
          <Badge variant="outline">
            <Spinner className="size-3" />
            Review running
          </Badge>
        )}
        {reply?.ok === true && reply.schedule && <span className="text-xs text-muted-foreground">{nextReviewLabel(reply.schedule, now)}</span>}
      </TopBarTitle>
      <TopBar>
        <ToolbarAction label="Review now" disabled={running || starting} onClick={() => void start()}>
          <PlayIcon />
        </ToolbarAction>
      </TopBar>

      <div className="relative min-h-0 flex-1">
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
                <ClipboardCheckIcon />
              </EmptyMedia>
              <EmptyTitle>Cannot read reviews</EmptyTitle>
              <EmptyDescription>{reply.error ?? "The editor server did not answer."}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : reviews.length === 0 ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ClipboardCheckIcon />
              </EmptyMedia>
              <EmptyTitle>No reviews yet</EmptyTitle>
              <EmptyDescription>
                {startError ?? "Review now reads the Access logs since the last Review and reports what deserves your attention."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ReviewsTable
            reviews={reviews}
            now={now}
            onOpen={onOpen}
            notice={startError ?? (failed ? "Cannot refresh; showing the last list." : undefined)}
          />
        )}
        {open && <ReviewDrawer review={open} links={{ sites, now }} onAskAssistant={onAskAssistant} onClose={() => closePanel(["review"])} />}
      </div>
    </div>
  )
}
