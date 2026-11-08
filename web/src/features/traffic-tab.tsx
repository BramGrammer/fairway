import { useId, type ReactNode } from "react"
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"
import { ActivityIcon } from "lucide-react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import type { HostStats, MetricsReply } from "@/lib/api"
import { cn } from "@/lib/utils"
import { codeSplit, estimateTraffic, type CodeClass } from "@/lib/traffic"

const SPLIT_COLORS: Record<CodeClass, string> = {
  "2xx": "bg-success",
  "3xx": "bg-muted-foreground/60",
  "4xx": "bg-primary",
  "5xx": "bg-destructive",
}

const fmtCount = (n: number) => Math.round(n).toLocaleString()
const fmtRate = (rate: number) => (rate >= 10 ? `${Math.round(rate)}/s` : rate >= 0.1 ? `${rate.toFixed(1)}/s` : rate > 0 ? "<0.1/s" : "idle")
const fmtPercent = (share: number) => (share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`)

const CHART_CONFIG = { requests: { label: "Requests", color: "var(--primary)" } } satisfies ChartConfig

function RequestsChart({ values, windowPhrase }: { values: number[]; windowPhrase: string }) {
  const gradient = useId()
  if (values.length < 2 || !values.some((v) => v > 0)) {
    return <div className="flex h-44 items-center justify-center text-sm text-muted-foreground">No requests in this window.</div>
  }
  const data = values.map((requests, i) => ({ i, requests }))
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span className="font-medium uppercase tracking-wider">Requests over time</span>
        <span className="tabular-nums">peak {fmtCount(Math.max(...values))}</span>
      </div>
      <ChartContainer config={CHART_CONFIG} className="aspect-auto h-44 w-full">
        <AreaChart data={data} margin={{ top: 6, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-requests)" stopOpacity={0.4} />
              <stop offset="100%" stopColor="var(--color-requests)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 5" />
          <XAxis dataKey="i" hide />
          <ChartTooltip cursor={{ strokeDasharray: "3 3" }} content={<ChartTooltipContent hideLabel indicator="line" />} />
          <Area
            dataKey="requests"
            type="monotone"
            stroke="var(--color-requests)"
            strokeWidth={2}
            fill={`url(#${gradient})`}
            dot={false}
            activeDot={{ r: 4 }}
            isAnimationActive
            animationDuration={600}
          />
        </AreaChart>
      </ChartContainer>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{windowPhrase} ago</span>
        <span>now</span>
      </div>
    </div>
  )
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "bad" }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-muted/50 px-3.5 py-3">
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn("text-2xl font-semibold tabular-nums tracking-tight", tone === "bad" && "text-destructive")}>{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

interface TrafficTabProps {
  /** What the metrics poll last returned, for the Routes page's window. */
  metrics: MetricsReply | null
  /** Stats of each Site that feeds the selected node, and how much of its traffic reaches the node. */
  parts: { stats: HostStats | null; fraction: number }[]
  /** True for Rules and Destinations, whose numbers are derived from their Site's. */
  estimated: boolean
  /** The window as a phrase, such as "5 minutes". */
  windowPhrase: string
}

function TrafficCard({ description, children }: { description: string; children: ReactNode }) {
  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ActivityIcon className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <CardTitle>Traffic</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  )
}

const Note = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>

const PER_HOST = (
  <>
    Add <code className="font-mono">metrics {"{ per_host }"}</code> to the global options to see traffic here.
  </>
)

/** Live numbers for the selected node: figures, a chart over the window and the status code split. */
export function TrafficTab({ metrics, parts, estimated, windowPhrase }: TrafficTabProps) {
  const result = estimateTraffic(parts)

  if (!metrics) return <TrafficCard description="Loading…"><Skeleton className="h-32 w-full" /></TrafficCard>
  if (!metrics.ok) return <TrafficCard description="Unavailable"><Note>{metrics.error}</Note></TrafficCard>
  if (!metrics.enabled) return <TrafficCard description="Switched off"><Note>{PER_HOST}</Note></TrafficCard>
  if (!metrics.perHost) return <TrafficCard description="Metrics are on, but not per site"><Note>{PER_HOST}</Note></TrafficCard>
  if (!result) {
    return (
      <TrafficCard description="No data yet">
        <Note>Caddy has not reported any requests for this site.</Note>
      </TrafficCard>
    )
  }

  const { stats, share } = result
  const failing = stats.requests > 0 ? stats.codes["5xx"] / stats.requests : 0
  return (
    <TrafficCard
      description={
        estimated
          ? `Last ${windowPhrase} · estimate, about ${fmtPercent(share)} of its Site's traffic`
          : `Last ${windowPhrase}`
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Tile label="Rate now" value={fmtRate(stats.rate)} />
        <Tile
          label="Requests"
          value={fmtCount(stats.requests)}
          hint={failing > 0 ? `${fmtPercent(failing)} server errors` : undefined}
          tone={failing > 0.05 ? "bad" : undefined}
        />
        <Tile label="Avg latency" value={`${Math.round(stats.avgMs)} ms`} />
        <Tile label="In flight" value={fmtCount(stats.inFlight)} />
      </div>
      <RequestsChart values={stats.history} windowPhrase={windowPhrase} />
      <StatusSplit stats={stats} />
    </TrafficCard>
  )
}

function StatusSplit({ stats }: { stats: HostStats }) {
  const split = codeSplit(stats)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted" role="presentation">
        {split.map(({ key, share }) => (
          <div key={key} className={cn(SPLIT_COLORS[key], "transition-[width] duration-500")} style={{ width: `${share * 100}%` }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums">
        {split.map(({ key, count, share }) => (
          <li key={key} className="flex items-center gap-2">
            <span className={cn("size-2.5 rounded-full", SPLIT_COLORS[key])} />
            <span className="font-medium">{key}</span>
            <span className="text-muted-foreground">
              {fmtCount(count)} · {fmtPercent(share)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
