import { cn } from "@/lib/utils"
import type { Health, UpstreamHealth } from "@/lib/upstream-health"

const LABELS: Record<Health, string> = { healthy: "Up", down: "Down" }

/** A small status dot in semantic colours. Renders nothing while health is unknown. */
export function HealthDot({ health, title, className }: { health: Health | null; title?: string; className?: string }) {
  if (!health) return null
  return (
    <span
      role="img"
      aria-label={LABELS[health]}
      title={title ?? LABELS[health]}
      className={cn("size-2 shrink-0 rounded-full", health === "down" ? "bg-destructive" : "bg-success", className)}
    />
  )
}

/** Status text for the drawer: "Up", or "Down" with the failure count. */
export function HealthStatus({ state }: { state: UpstreamHealth | null }) {
  if (!state) return null
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <HealthDot health={state.health} />
      {LABELS[state.health]}
      {state.fails > 0 && ` · ${state.fails} ${state.fails === 1 ? "failure" : "failures"}`}
    </span>
  )
}
