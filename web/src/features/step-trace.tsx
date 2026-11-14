import { useState, type ReactNode } from "react"
import {
  CheckIcon,
  CircleAlertIcon,
  PencilIcon,
  SearchIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { Spinner } from "@/components/ui/spinner"
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace"
import {
  formatDuration,
  type AssistantMessage,
  type TurnStep,
} from "@/lib/assistant"

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

/** What a Validation or a check found, in a few words. */
function outcome(step: { errors: number; warnings: number }): string {
  if (step.errors > 0) return plural(step.errors, "error")
  if (step.warnings > 0) return plural(step.warnings, "warning")
  return "valid"
}

/** One step as a line of the trace: what ran, and how long it took or what came of it. */
function describeStep(step: TurnStep): {
  icon: ReactNode
  title: string
  detail?: string
  error?: boolean
} {
  switch (step.kind) {
    case "checked":
      return {
        icon:
          step.errors > 0 ? (
            <CircleAlertIcon />
          ) : step.warnings > 0 ? (
            <TriangleAlertIcon />
          ) : (
            <CheckIcon />
          ),
        title: "Checked the Caddyfile in the editor",
        detail: `${outcome(step)} · ${formatDuration(step.ms)}`,
      }
    case "model":
      return {
        icon: <SparklesIcon />,
        title:
          step.toolCalls > 0
            ? `Asked the model, which made ${plural(step.toolCalls, "tool call")}`
            : "Asked the model",
        detail: formatDuration(step.ms),
      }
    case "edit":
      return step.applied
        ? {
            icon: <PencilIcon />,
            title: `Edited the draft`,
            detail: plural(step.edits, "edit"),
          }
        : {
            icon: <CircleAlertIcon />,
            title: "An edit did not apply to the draft",
            error: true,
          }
    case "lookup":
      return {
        icon: step.ok ? <SearchIcon /> : <CircleAlertIcon />,
        title: !step.ok
          ? `A look at the ${step.tool === "routes" ? "routes" : "Access log"} did not work`
          : step.tool === "routes"
            ? "Looked at the running routes"
            : "Looked at the Access log",
        detail:
          step.ok && step.tool === "logs" && step.lines !== null
            ? `${plural(step.lines, "line")} · ${formatDuration(step.ms)}`
            : formatDuration(step.ms),
        error: !step.ok,
      }
    case "validate":
      return {
        icon: step.errors > 0 ? <CircleAlertIcon /> : <CheckIcon />,
        title: `Validated the draft with Caddy (attempt ${step.attempt})`,
        detail: `${outcome(step)} · ${formatDuration(step.ms)}`,
        error: step.errors > 0,
      }
  }
}

/**
 * What the Assistant did for an answer, as a collapsed line the Owner can open: how long it took, then each step that
 * ran. It is open while the answer is still being made, so the steps show as they happen.
 */
export function StepTrace({
  message,
  running,
}: {
  message: AssistantMessage
  running: boolean
}) {
  const [opened, setOpened] = useState(false)
  const steps = message.steps ?? []
  if (steps.length === 0) return null
  const title = running
    ? "Working…"
    : message.elapsedMs !== undefined
      ? `Worked for ${formatDuration(message.elapsedMs)}`
      : "Worked"
  return (
    <Trace>
      <TraceCollapsible open={running || opened} onOpenChange={setOpened}>
        <TraceCollapsibleTrigger>
          <TraceLine
            status={running ? "running" : undefined}
            className="text-xs"
          >
            <TraceIcon>{running ? <Spinner /> : <SparklesIcon />}</TraceIcon>
            <TraceTitle>{title}</TraceTitle>
            <TraceDescription>{plural(steps.length, "step")}</TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="flex flex-col gap-1.5 text-xs">
          {steps.map((step, i) => {
            const line = describeStep(step)
            return (
              <TraceLine
                key={i}
                status={line.error ? "error" : undefined}
                className="text-xs"
              >
                <TraceIcon>{line.icon}</TraceIcon>
                <TraceTitle>{line.title}</TraceTitle>
                {line.detail && (
                  <TraceDescription>{line.detail}</TraceDescription>
                )}
              </TraceLine>
            )
          })}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}
