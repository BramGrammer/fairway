import { useMemo } from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useTimeline } from "@/hooks/use-timeline"
import { cn } from "@/lib/utils"
import {
  segmentLabel,
  STATE_LABELS,
  summarize,
  toSegments,
  type Segment,
  type TimelineState,
} from "@/lib/timeline"

const COLORS: Record<TimelineState, string> = {
  ok: "bg-success",
  warning: "bg-amber-500",
  down: "bg-destructive",
  unknown: "bg-muted bg-[repeating-linear-gradient(135deg,transparent_0_3px,var(--border)_3px_5px)]",
}

function Bar({ segments, compact }: { segments: Segment[]; compact: boolean }) {
  return (
    <div className={cn("flex w-full overflow-hidden rounded-sm bg-muted", compact ? "h-2" : "h-4")}>
      {segments.map((segment, i) => (
        <Tooltip key={i}>
          <TooltipTrigger
            render={<span />}
            aria-label={segmentLabel(segment)}
            className={cn("block h-full", COLORS[segment.state])}
            style={{ width: `${segment.widthPct}%` }}
          />
          <TooltipContent>{segmentLabel(segment)}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

/** The last 24 h of one host as coloured segments. Renders nothing until data arrives or when the host is unknown to it. */
export function TimelineStrip({ host, compact = false }: { host: string; compact?: boolean }) {
  const reply = useTimeline()
  const segments = useMemo(
    () => (reply?.ok && reply.hosts[host] ? toSegments(reply.hosts[host], reply.from, reply.to) : []),
    [reply, host],
  )
  if (!reply?.ok || segments.length === 0) return null

  if (compact) {
    return (
      <div className="w-32" role="img" aria-label={`Last 24 h: ${summarize(segments, reply.to - reply.from)}`}>
        <Bar segments={segments} compact />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">Last 24 hours</h3>
        <span className="text-xs text-muted-foreground">{summarize(segments, reply.to - reply.from)}</span>
      </div>
      <Bar segments={segments} compact={false} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {(["ok", "warning", "down", "unknown"] as const).map((state) => (
          <span key={state} className="inline-flex items-center gap-1.5">
            <span className={cn("size-2 rounded-sm", COLORS[state])} />
            {STATE_LABELS[state]}
          </span>
        ))}
      </div>
    </div>
  )
}
