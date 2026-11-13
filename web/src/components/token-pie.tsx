import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  approximateCost,
  CONTEXT_LABELS,
  formatCost,
  formatTokens,
  type ContextKey,
  type UsageBreakdown,
} from "@/lib/assistant"
import type { AiPrice } from "@/lib/ai-settings"
import { cn } from "@/lib/utils"

const RADIUS = 5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** One colour per part of the context, apart enough to tell in a pie this small. */
const COLORS: Record<ContextKey, string> = {
  caddyfile: "var(--primary)",
  instructions: "oklch(0.65 0.12 250)",
  conversation: "oklch(0.68 0.13 160)",
  findings: "oklch(0.65 0.15 25)",
  proposal: "oklch(0.65 0.14 310)",
  placeholders: "oklch(0.72 0.1 200)",
  tool: "oklch(0.6 0.02 260)",
}

/** The context as a pie: a slice for each part of the latest request. An empty ring when there is nothing to show. */
function Pie({
  usage,
  className,
}: {
  usage: UsageBreakdown
  className?: string
}) {
  let offset = 0
  return (
    <svg
      viewBox={`0 0 ${RADIUS * 2} ${RADIUS * 2}`}
      className={cn("size-4", className)}
      aria-hidden="true"
    >
      {usage.contextTotal === 0 ? (
        <circle
          r={RADIUS - 0.5}
          cx={RADIUS}
          cy={RADIUS}
          fill="none"
          strokeWidth={1}
          className="stroke-muted-foreground/40"
        />
      ) : (
        usage.context.map((part) => {
          const length = (part.tokens / usage.contextTotal) * CIRCUMFERENCE
          const start = offset
          offset += length
          // A stroke as wide as the radius, drawn on a circle of half the radius, fills the pie: each arc is one slice.
          return (
            <circle
              key={part.key}
              r={RADIUS / 2}
              cx={RADIUS}
              cy={RADIUS}
              fill="none"
              strokeWidth={RADIUS}
              stroke={COLORS[part.key]}
              strokeDasharray={`${length / 2} ${CIRCUMFERENCE}`}
              strokeDashoffset={-start / 2}
              transform={`rotate(-90 ${RADIUS} ${RADIUS})`}
            />
          )
        })
      )}
    </svg>
  )
}

function Row({
  swatch,
  label,
  value,
}: {
  swatch?: string
  label: string
  value: string
}) {
  return (
    <div className="flex items-center gap-2">
      {swatch !== undefined && (
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ background: swatch }}
          aria-hidden="true"
        />
      )}
      <span className="opacity-70">{label}</span>
      <span className="ml-auto pl-4 tabular-nums">{value}</span>
    </div>
  )
}

function Heading({ children }: { children: string }) {
  return (
    <span className="mt-1 text-[10px] font-medium tracking-wide uppercase opacity-60 first:mt-0">
      {children}
    </span>
  )
}

/**
 * The context indicator of the Assistant's input: a pie of what the latest request was made of, and on hover or focus
 * the sizes of its parts, what the Conversation has used, and what that comes to at the Owner's prices.
 */
export function TokenPie({
  usage,
  price,
}: {
  usage: UsageBreakdown
  price: AiPrice | null
}) {
  const label =
    usage.contextTotal > 0
      ? `Context: about ${formatTokens(usage.contextTotal)} tokens`
      : usage.total > 0
        ? `${formatTokens(usage.total)} tokens used`
        : "No tokens used yet"
  const sorted = [...usage.context].sort((a, b) => b.tokens - a.tokens)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            role="img"
            aria-label={label}
            className="flex size-6 items-center justify-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        }
      >
        <Pie usage={usage} />
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        className="min-w-56 flex-col items-stretch gap-1 py-2"
      >
        {usage.total === 0 && usage.contextTotal === 0 ? (
          <span className="opacity-70">Nothing sent yet.</span>
        ) : (
          <>
            {usage.contextTotal > 0 && (
              <>
                <Heading>Context of the last request</Heading>
                {sorted.map((part) => (
                  <Row
                    key={part.key}
                    swatch={COLORS[part.key]}
                    label={CONTEXT_LABELS[part.key]}
                    value={`≈ ${formatTokens(part.tokens)}`}
                  />
                ))}
                <Row
                  label="Estimated"
                  value={`≈ ${formatTokens(usage.contextTotal)}`}
                />
                {usage.lastInput > 0 && (
                  <Row
                    label="Counted by the model"
                    value={formatTokens(usage.lastInput)}
                  />
                )}
              </>
            )}
            {usage.total > 0 && (
              <>
                <Heading>This Conversation</Heading>
                <Row label="Input" value={formatTokens(usage.input)} />
                <Row label="Output" value={formatTokens(usage.output)} />
                <Row label="Total" value={formatTokens(usage.total)} />
                <Row label="Answers" value={String(usage.turns)} />
                {price && (
                  <Row
                    label="Approximate cost"
                    value={formatCost(
                      approximateCost(
                        {
                          promptTokens: usage.input,
                          completionTokens: usage.output,
                        },
                        price
                      )
                    )}
                  />
                )}
              </>
            )}
            {usage.contextTotal === 0 && (
              <span className="mt-1 opacity-60">
                The parts of the context show after the next question.
              </span>
            )}
          </>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
