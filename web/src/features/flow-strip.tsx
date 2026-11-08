import { useEffect, useState, type CSSProperties } from "react"

import { cn } from "@/lib/utils"

export interface FlowItem {
  key: string
  title: string
  sub?: string
  mono?: boolean
}

type Noun = readonly [singular: string, plural: string]

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches

/** Seconds per trip along a line: about 3s at a trickle, down to 0.5s at 50 requests a second. Idle or unknown traffic moves slowly. */
export function flowDuration(rate: number | null | undefined): number {
  if (rate === null || rate === undefined || rate <= 0) return 3.5
  return Math.max(0.5, Math.min(3, 3 - 1.5 * Math.log10(1 + rate)))
}

/** Counts up to `target` with an ease-out, so the numbers land instead of just appearing. */
function useCountUp(target: number, duration = 700): number {
  const [value, setValue] = useState(() => (reducedMotion() ? target : 0))
  useEffect(() => {
    if (reducedMotion()) return
    const start = performance.now()
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / duration)
      setValue(Math.round(target * (1 - (1 - t) ** 3)))
      if (t < 1) frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [target, duration])
  return reducedMotion() ? target : value
}

/** The big number for one side: how many nodes lead in or out. */
function Count({ count, noun, side }: { count: number; noun: Noun; side: "in" | "out" }) {
  const shown = useCountUp(count)
  return (
    <div
      className={cn(
        "flex min-w-[68px] shrink-0 flex-col items-center rounded-2xl border bg-linear-to-b from-primary/15 to-primary/5 px-2 py-3",
        "animate-in fade-in duration-500",
        side === "in" ? "slide-in-from-left-3" : "slide-in-from-right-3",
      )}
    >
      <span className="text-3xl leading-none font-semibold tabular-nums tracking-tight">{shown}</span>
      <span className="mt-1.5 text-[10px] tracking-wide text-muted-foreground uppercase">{count === 1 ? noun[0] : noun[1]}</span>
    </div>
  )
}

/** One line between a count and the card, with a soft gradient sweeping along it at a pace set by the traffic. */
function Line({ seconds }: { seconds: number }) {
  return (
    <span aria-hidden className="relative h-0.5 min-w-8 flex-1 overflow-hidden rounded-full bg-border">
      <span
        className="flow-sweep absolute inset-y-0 left-0 w-2/5 bg-linear-to-r from-transparent via-primary to-transparent"
        style={{ animationDuration: `${seconds}s` } as CSSProperties}
      />
    </span>
  )
}

interface FlowStripProps {
  /** Where traffic comes from. */
  before?: FlowItem[]
  /** Where it goes next. */
  after?: FlowItem[]
  beforeNoun?: Noun
  afterNoun?: Noun
  /** Requests per second through the node; faster traffic makes the lines sweep faster. */
  rate?: number | null
  current: Omit<FlowItem, "key"> & { eyebrow: string }
}

/** The selected node in the middle; counts on each side say how many nodes lead in and out. */
export function FlowStrip({ before = [], after = [], beforeNoun = ["source", "sources"], afterNoun = ["next", "next"], rate, current }: FlowStripProps) {
  const seconds = flowDuration(rate)
  return (
    <div className="flex items-center gap-2">
      {before.length > 0 && (
        <>
          <Count count={before.length} noun={beforeNoun} side="in" />
          <Line seconds={seconds} />
        </>
      )}
      <div
        className={cn(
          "flex min-w-0 flex-[2] flex-col justify-center rounded-2xl border border-primary/50 bg-card px-4 py-3.5",
          "animate-in fade-in zoom-in-95 shadow-lg ring-1 shadow-primary/20 ring-primary/20 duration-500",
        )}
      >
        <span className="truncate text-[11px] font-medium tracking-wider text-primary uppercase">{current.eyebrow}</span>
        <span className={cn("truncate text-base font-semibold", current.mono && "font-mono")}>{current.title}</span>
        {current.sub && <span className="truncate text-xs text-muted-foreground">{current.sub}</span>}
      </div>
      {after.length > 0 && (
        <>
          <Line seconds={seconds} />
          <Count count={after.length} noun={afterNoun} side="out" />
        </>
      )}
    </div>
  )
}
