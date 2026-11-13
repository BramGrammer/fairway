import { useState } from "react"
import { PlugZapIcon, WrenchIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FieldDescription, FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { ErrorLine, ResetButton } from "@/features/settings-shared"
import { useAiModels, useAiSettings, useAiTest, useModelTest } from "@/hooks/use-ai-settings"
import type { Outcome } from "@/hooks/use-alert-settings"
import { AI_LOGIN_REQUIRED, apiKeyBody, baseUrlBody, describeBaseUrl, describeInterval, describeKey, INTERVAL_LABELS, REVIEW_INTERVALS, type ReviewInterval, describeModel, describePrice, filterModels, modelBody, MODEL_FIELD, priceBody, type AiPutBody, type AiSettingsView, type AiTask } from "@/lib/ai-settings"
import { cn } from "@/lib/utils"

type Save = (body: AiPutBody) => Promise<Outcome>

function AddressField({ view, canEdit, save, onChanged }: { view: AiSettingsView["baseUrl"]; canEdit: boolean; save: Save; onChanged: () => void }) {
  // Remounted by its key when the saved value changes, so the draft always starts from the server's.
  const [text, setText] = useState(view.value)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (body: AiPutBody | null, error?: string) => {
    if (!body) return setError(error ?? null)
    setBusy(true)
    const outcome = await save(body)
    setBusy(false)
    setError(outcome.ok ? null : outcome.error)
    if (outcome.ok) onChanged()
  }
  const commit = () => {
    const parsed = baseUrlBody(text)
    return parsed.ok ? run(parsed.body) : run(null, parsed.error)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="ai-base-url">Address</Label>
      <div className="flex items-center gap-2">
        <Input
          id="ai-base-url"
          type="url"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void commit()}
          disabled={!canEdit}
          aria-invalid={error !== null}
          className="max-w-md font-mono"
        />
        <Button variant="outline" size="sm" onClick={commit} disabled={!canEdit || busy || text.trim() === view.value}>
          Save
        </Button>
        {view.overridden && canEdit && <ResetButton onClick={() => run({ baseUrl: null })} disabled={busy} />}
        {view.overridden && <Badge variant="secondary">Changed</Badge>}
      </div>
      <ErrorLine message={error} />
      <FieldDescription>Any OpenAI-compatible endpoint: OpenRouter, OpenAI, or a local server. {describeBaseUrl(view)}</FieldDescription>
    </div>
  )
}

function KeyField({ view, canEdit, save, onChanged }: { view: AiSettingsView["apiKey"]; canEdit: boolean; save: Save; onChanged: () => void }) {
  const [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (body: AiPutBody) => {
    setBusy(true)
    const outcome = await save(body)
    setBusy(false)
    setError(outcome.ok ? null : outcome.error)
    if (outcome.ok) {
      setText("")
      onChanged()
    }
  }
  const commit = () => {
    const parsed = apiKeyBody(text)
    if (parsed.ok) return run(parsed.body)
    setError(parsed.error)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="ai-api-key">Key</Label>
      <div className="flex items-center gap-2">
        <Input
          id="ai-api-key"
          type="password"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void commit()}
          placeholder={view.set ? "Leave empty to keep the current key" : ""}
          autoComplete="new-password"
          disabled={!canEdit}
          aria-invalid={error !== null}
          className="max-w-md font-mono"
        />
        <Button variant="outline" size="sm" onClick={commit} disabled={!canEdit || busy || text.trim() === ""}>
          Save
        </Button>
        {view.overridden && canEdit && <ResetButton onClick={() => run({ apiKey: null })} disabled={busy} />}
        {view.overridden && <Badge variant="secondary">Changed</Badge>}
      </div>
      <ErrorLine message={error} />
      <FieldDescription>{describeKey(view)}</FieldDescription>
    </div>
  )
}

const TASK_LABEL: Record<AiTask, string> = { assistant: "Assistant model", review: "Reviews model" }

/**
 * One task's model: a text box that suggests from the endpoint's list as the Owner types. With no list it is the
 * same box without suggestions, so a name can always be typed.
 */
function ModelField({ task, view, models, canEdit, save }: { task: AiTask; view: AiSettingsView["assistantModel"]; models: string[] | null; canEdit: boolean; save: Save }) {
  const [text, setText] = useState(view.value ?? "")
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const test = useModelTest(task)
  const id = `ai-model-${task}`

  const run = async (body: AiPutBody | null, message?: string) => {
    if (!body) return setError(message ?? null)
    setBusy(true)
    const outcome = await save(body)
    setBusy(false)
    setError(outcome.ok ? null : outcome.error)
  }
  const commit = (value = text) => {
    const parsed = modelBody(task, value)
    return parsed.ok ? run(parsed.body) : run(null, parsed.error)
  }
  const matches = models ? filterModels(models, text === view.value ? "" : text).slice(0, 50) : []

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{TASK_LABEL[task]}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-md">
          <Input
            id={id}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit()
              if (e.key === "Escape") setOpen(false)
            }}
            disabled={!canEdit}
            role="combobox"
            aria-expanded={open && matches.length > 0}
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-invalid={error !== null}
            placeholder={models ? "Search the models" : "Type the model name"}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          {open && canEdit && matches.length > 0 && (
            <ul id={`${id}-list`} role="listbox" className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
              {matches.map((m) => (
                <li
                  key={m}
                  role="option"
                  aria-selected={m === view.value}
                  // Mouse down, not click: the input's blur would close the list first.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setText(m)
                    setOpen(false)
                    void commit(m)
                  }}
                  className="cursor-pointer rounded-md px-2 py-1 font-mono text-xs hover:bg-accent hover:text-accent-foreground"
                >
                  {m}
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => commit()} disabled={!canEdit || busy || text.trim() === (view.value ?? "")}>
          Save
        </Button>
        {view.overridden && canEdit && (
          <ResetButton
            onClick={async () => {
              await run({ [MODEL_FIELD[task]]: null })
            }}
            disabled={busy}
          />
        )}
        {view.overridden && <Badge variant="secondary">Changed</Badge>}
      </div>
      <ErrorLine message={error} />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={test.run} disabled={test.testing || !view.value}>
          {test.testing ? <Spinner data-icon="inline-start" /> : <WrenchIcon data-icon="inline-start" />}
          Test tool calling
        </Button>
        {test.result && (
          <span role="status" className={cn("text-xs", test.result.ok ? "text-success" : "text-destructive")}>
            {test.result.ok ? "The model called the tool." : `Test failed: ${test.result.error}`}
          </span>
        )}
      </div>
      <FieldDescription>
        {describeModel(view)} It must support tool calling.
        {!models && " The endpoint offers no model list, so type the name."}
      </FieldDescription>
    </div>
  )
}

/** What the Assistant's model costs per million tokens, for the approximate cost on its token indicator. */
function PriceField({ view, canEdit, save }: { view: AiSettingsView["assistantPrice"]; canEdit: boolean; save: Save }) {
  const [input, setInput] = useState(view ? String(view.input) : "")
  const [output, setOutput] = useState(view ? String(view.output) : "")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (body: AiPutBody) => {
    setBusy(true)
    const outcome = await save(body)
    setBusy(false)
    setError(outcome.ok ? null : outcome.error)
  }
  const commit = () => {
    const parsed = priceBody(input, output)
    return parsed.ok ? run(parsed.body) : setError(parsed.error)
  }
  const unchanged = view !== null && input.trim() === String(view.input) && output.trim() === String(view.output)

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="ai-price-input">Assistant price per million tokens</Label>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Input $</span>
        <Input id="ai-price-input" inputMode="decimal" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void commit()} disabled={!canEdit} aria-invalid={error !== null} className="w-24 font-mono" />
        <span className="text-sm text-muted-foreground">Output $</span>
        <Input aria-label="Output price per million tokens" inputMode="decimal" value={output} onChange={(e) => setOutput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void commit()} disabled={!canEdit} aria-invalid={error !== null} className="w-24 font-mono" />
        <Button variant="outline" size="sm" onClick={commit} disabled={!canEdit || busy || unchanged}>
          Save
        </Button>
        {view && canEdit && <ResetButton onClick={() => run({ assistantPrice: null })} disabled={busy} />}
        {view && <Badge variant="secondary">Changed</Badge>}
      </div>
      <ErrorLine message={error} />
      <FieldDescription>{describePrice(view)}</FieldDescription>
    </div>
  )
}

/** How often a Review runs by itself. A choice from a short list, saved at once. */
function IntervalField({ view, canEdit, save }: { view: AiSettingsView["reviewInterval"]; canEdit: boolean; save: Save }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const items = REVIEW_INTERVALS.map((value) => ({ value, label: INTERVAL_LABELS[value] }))

  const run = async (body: AiPutBody) => {
    setBusy(true)
    const outcome = await save(body)
    setBusy(false)
    setError(outcome.ok ? null : outcome.error)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="ai-review-interval">Reviews run</Label>
      <div className="flex items-center gap-2">
        <Select items={items} value={view.value} onValueChange={(value) => value && void run({ reviewInterval: value as ReviewInterval })} disabled={!canEdit || busy}>
          <SelectTrigger id="ai-review-interval" className="w-56">
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
        {view.overridden && canEdit && <ResetButton onClick={() => run({ reviewInterval: null })} disabled={busy} />}
        {view.overridden && <Badge variant="secondary">Changed</Badge>}
      </div>
      <ErrorLine message={error} />
      <FieldDescription>How often a Review runs by itself. It needs the Reviews model and a login. {describeInterval(view)}</FieldDescription>
    </div>
  )
}

function TestButton() {
  const { testing, result, run } = useAiTest()
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" size="sm" onClick={run} disabled={testing}>
        {testing ? <Spinner data-icon="inline-start" /> : <PlugZapIcon data-icon="inline-start" />}
        Test connection
      </Button>
      {result && (
        <span role="status" className={cn("text-xs", result.ok ? "text-success" : "text-destructive")}>
          {result.ok ? "The endpoint answered." : `Test failed: ${result.error}`}
        </span>
      )}
    </div>
  )
}

/** The AI category: where the model endpoint is and the key for it. */
export function AiSettingsPanel() {
  const { view, loadError, reload, save } = useAiSettings()
  // A saved change makes an old test result stale.
  const [testKey, setTestKey] = useState(0)
  const { models } = useAiModels(`${view?.baseUrl.value}|${view?.apiKey.set}|${view?.apiKey.source}`)

  if (!view) {
    return loadError ? (
      <div className="flex flex-col items-start gap-2">
        <ErrorLine message={loadError} />
        <Button variant="outline" size="sm" onClick={() => void reload()}>
          Try again
        </Button>
      </div>
    ) : (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading…
      </div>
    )
  }
  const changed = () => setTestKey((n) => n + 1)

  return (
    <FieldSet>
      <FieldLegend>Model endpoint</FieldLegend>
      <FieldGroup className="gap-5">
        {!view.canEdit && (
          <p role="status" className="rounded-lg border p-3 text-sm text-muted-foreground">
            {AI_LOGIN_REQUIRED}
          </p>
        )}
        <AddressField key={`a-${view.baseUrl.value}`} view={view.baseUrl} canEdit={view.canEdit} save={save} onChanged={changed} />
        <KeyField key={`k-${String(view.apiKey.set)}-${view.apiKey.source}`} view={view.apiKey} canEdit={view.canEdit} save={save} onChanged={changed} />
        <TestButton key={testKey} />
        <ModelField key={`m-a-${view.assistantModel.value}-${testKey}`} task="assistant" view={view.assistantModel} models={models} canEdit={view.canEdit} save={save} />
        <PriceField key={`p-${view.assistantPrice?.input}-${view.assistantPrice?.output}`} view={view.assistantPrice} canEdit={view.canEdit} save={save} />
        <ModelField key={`m-r-${view.reviewModel.value}-${testKey}`} task="review" view={view.reviewModel} models={models} canEdit={view.canEdit} save={save} />
        <IntervalField key={`i-${view.reviewInterval.value}`} view={view.reviewInterval} canEdit={view.canEdit} save={save} />
      </FieldGroup>
    </FieldSet>
  )
}
