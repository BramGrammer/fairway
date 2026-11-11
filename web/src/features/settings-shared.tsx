import { useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { Outcome } from "@/hooks/use-alert-settings"
import {
  TIMING_FIELDS,
  describeTiming,
  parseNumberField,
  timingBody,
  unitFor,
  type AlertSettingsView,
  type PutBody,
} from "@/lib/alert-settings"

export type Save = (body: PutBody) => Promise<Outcome>

export function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p role="alert" className="text-xs text-destructive">
      {message}
    </p>
  )
}

export function ResetButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <Button type="button" variant="ghost" size="sm" onClick={onClick} disabled={disabled}>
      Reset
    </Button>
  )
}

export function TimingRow({ field, view, save }: { field: (typeof TIMING_FIELDS)[number]; view: AlertSettingsView["timing"][typeof field.key]; save: Save }) {
  const [text, setText] = useState(String(view.value))
  const [error, setError] = useState<string | null>(null)
  const lastSent = useRef(view.value)
  const id = `timing-${field.key}`

  const commit = async () => {
    const parsed = parseNumberField(text, view.min, view.max)
    if (!parsed.ok) return setError(parsed.error)
    if (parsed.value === lastSent.current) return setError(null)
    lastSent.current = parsed.value
    const outcome = await save(timingBody(field.key, parsed.value))
    if (!outcome.ok) lastSent.current = view.value
    setError(outcome.ok ? null : outcome.error)
  }
  const reset = async () => {
    const outcome = await save(timingBody(field.key, null))
    if (outcome.ok) {
      lastSent.current = view.default
      setText(String(view.default))
    }
    setError(outcome.ok ? null : outcome.error)
  }

  return (
    <div className="flex flex-col gap-1 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Label htmlFor={id} className="font-normal">
          {field.before}
        </Label>
        <Input
          id={id}
          inputMode="numeric"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && void commit()}
          aria-invalid={error !== null}
          className="w-20 text-right tabular-nums"
        />
        <span>{unitFor(field, Number(text) || view.value)}</span>
        <span>{field.after}</span>
        {view.overridden && <ResetButton onClick={reset} />}
      </div>
      {error ? <ErrorLine message={error} /> : <span className="text-xs text-muted-foreground">{describeTiming(field, view)}</span>}
    </div>
  )
}
