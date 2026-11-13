import { Fragment, useState, type FormEvent } from "react"
import { BellIcon, BellOffIcon, PencilIcon, PlusIcon, SendIcon, Trash2Icon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FieldDescription, FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { ErrorLine, ResetButton, TimingRow, type Save } from "@/features/settings-shared"
import type { useAlertSettings, Outcome } from "@/hooks/use-alert-settings"
import { useAlertTest } from "@/hooks/use-alert-test"
import { REVIEW_LEVEL_HINT, REVIEW_LEVEL_OPTIONS, TIMING_FIELDS, groupTriggers, reviewLevelBody, topicBody, triggerBody, type ReviewLevel, type AlertSettingsView, type PutBody, type TopicView } from "@/lib/alert-settings"
import { cn } from "@/lib/utils"

/** Add or change a saved topic. The address and token are write-only: empty keeps what is stored. */
function TopicForm({
  topic,
  onSubmit,
  onCancel,
  onRemoveToken,
}: {
  topic?: TopicView
  onSubmit: (body: { name: string; url?: string; token?: string }) => Promise<Outcome>
  onCancel: () => void
  onRemoveToken?: () => Promise<Outcome>
}) {
  const mode = topic ? "edit" : "add"
  const [name, setName] = useState(topic?.name ?? "")
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const finish = (outcome: Outcome) => {
    setBusy(false)
    setToken("")
    if (outcome.ok) onCancel()
    else setError(outcome.error)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const parsed = topicBody({ name, url, token }, mode)
    if (!parsed.ok) return setError(parsed.error)
    setError(null)
    setBusy(true)
    finish(await onSubmit(parsed.body))
  }

  const idPrefix = topic ? `topic-${topic.id}` : "topic-new"
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3" autoComplete="off">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-name`}>Name</Label>
          <Input id={`${idPrefix}-name`} value={name} onChange={(e) => setName(e.target.value)} placeholder="My phone" maxLength={60} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-url`}>Address</Label>
          <Input
            id={`${idPrefix}-url`}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://ntfy.example.test/fairway"
            className="font-mono"
          />
          {topic && <span className="text-xs text-muted-foreground">Never shown again. Leave empty to keep the current one.</span>}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-token`}>Access token (optional)</Label>
        <div className="flex items-center gap-2">
          <Input
            id={`${idPrefix}-token`}
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="new-password"
            className="max-w-xs font-mono"
          />
          {topic?.hasToken && onRemoveToken && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError(null)
                finish(await onRemoveToken())
              }}
            >
              Remove token
            </Button>
          )}
        </div>
        {topic && <span className="text-xs text-muted-foreground">{topic.hasToken ? "A token is set. Leave empty to keep it." : "No token is set."}</span>}
      </div>
      <ErrorLine message={error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy && <Spinner data-icon="inline-start" />}
          {topic ? "Save topic" : "Add topic"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function TopicRow({
  topic,
  canEditSecrets,
  editing,
  onEdit,
  onCancel,
  actions,
}: {
  topic: TopicView
  canEditSecrets: boolean
  editing: boolean
  onEdit: () => void
  onCancel: () => void
  actions: ReturnType<typeof useAlertSettings>
}) {
  const { testing, result, send } = useAlertTest(topic.id)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const saved = topic.source === "saved"

  const toggle = async (enabled: boolean) => {
    const outcome = await actions.updateTopic(topic.id, { enabled })
    setError(outcome.ok ? null : outcome.error)
  }
  const remove = async () => {
    const outcome = await actions.removeTopic(topic.id)
    if (!outcome.ok) setError(outcome.error)
    setConfirming(false)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-3">
        <Switch size="sm" checked={topic.enabled} onCheckedChange={toggle} aria-label={`Send Alerts to ${topic.name}`} />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn("text-sm font-medium", !topic.enabled && "text-muted-foreground")}>{topic.name}</span>
          {!saved && <Badge variant="outline">From the environment</Badge>}
          {topic.hasToken && <Badge variant="secondary">Token set</Badge>}
          {topic.host && <span className="truncate font-mono text-xs text-muted-foreground">{topic.host}</span>}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={send} disabled={testing}>
            {testing ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}
            Send test
          </Button>
          {saved && canEditSecrets && !confirming && (
            <>
              <Button variant="ghost" size="icon-sm" aria-label={`Edit ${topic.name}`} onClick={onEdit}>
                <PencilIcon />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Remove ${topic.name}`} onClick={() => setConfirming(true)}>
                <Trash2Icon />
              </Button>
            </>
          )}
          {confirming && (
            <>
              <Button variant="destructive" size="sm" onClick={remove}>
                Remove
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Keep
              </Button>
            </>
          )}
        </div>
        {result && (
          <span role="status" className={cn("basis-full text-xs", result.ok ? "text-success" : "text-destructive")}>
            {result.ok ? "Test alert sent." : `Test failed: ${result.error}`}
          </span>
        )}
        <ErrorLine message={error} />
      </div>
      {editing && (
        <TopicForm
          topic={topic}
          onCancel={onCancel}
          onSubmit={(body) => actions.updateTopic(topic.id, body)}
          onRemoveToken={() => actions.updateTopic(topic.id, { token: null })}
        />
      )}
    </div>
  )
}

function Destinations({ view, actions }: { view: AlertSettingsView; actions: ReturnType<typeof useAlertSettings> }) {
  const [editing, setEditing] = useState<string | "new" | null>(null)
  const anyOn = view.topics.some((topic) => topic.enabled)

  return (
    <FieldSet>
      <FieldLegend>Destinations</FieldLegend>
      <FieldGroup className="gap-3">
        <FieldDescription className="flex items-center gap-2">
          {anyOn ? <BellIcon className="size-4 shrink-0 text-success" /> : <BellOffIcon className="size-4 shrink-0" />}
          {anyOn ? "Alerts are on. Each message goes to every enabled topic." : "Alerts are off. The history is kept either way."}
        </FieldDescription>
        {view.topics.length === 0 && (
          <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
            No ntfy topic yet, so no Alert is sent.{" "}
            {view.canEditSecrets ? (
              "Add a topic below to get messages on your phone."
            ) : (
              <>
                Set <code className="font-mono text-xs">NTFY_URL</code> in the environment and restart, or turn on login to add one here.
              </>
            )}
          </p>
        )}
        {view.topics.map((topic) => (
          <TopicRow
            key={topic.id}
            topic={topic}
            canEditSecrets={view.canEditSecrets}
            editing={editing === topic.id}
            onEdit={() => setEditing(topic.id)}
            onCancel={() => setEditing(null)}
            actions={actions}
          />
        ))}
        {editing === "new" && view.canEditSecrets && (
          <TopicForm onCancel={() => setEditing(null)} onSubmit={(body) => actions.addTopic({ ...body, url: body.url ?? "" })} />
        )}
        {editing !== "new" && (
          <div>
            <Button variant="outline" size="sm" disabled={!view.canEditSecrets} onClick={() => setEditing("new")}>
              <PlusIcon data-icon="inline-start" />
              Add topic
            </Button>
          </div>
        )}
        {!view.canEditSecrets && (
          <FieldDescription>
            Topic addresses and tokens can only be changed when login is on. Set <code className="font-mono text-xs">AUTH_USER</code> and a password.
          </FieldDescription>
        )}
      </FieldGroup>
    </FieldSet>
  )
}

/** The two timing inputs of flapping, directly under its switch. */
function FlappingTiming({ view, save }: { view: AlertSettingsView; save: Save }) {
  return (
    <div className="flex flex-col divide-y bg-muted/30">
      <span className="px-3 pt-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Flapping</span>
      {(["flapChanges", "flapStableMin"] as const).map((key) => (
        <TimingRow key={`${key}:${view.timing[key].value}`} field={TIMING_FIELDS.find((f) => f.key === key)!} view={view.timing[key]} save={save} />
      ))}
    </div>
  )
}

function Triggers({ view, save }: { view: AlertSettingsView; save: Save }) {
  const [error, setError] = useState<string | null>(null)
  const run = async (body: PutBody) => {
    const outcome = await save(body)
    setError(outcome.ok ? null : outcome.error)
  }

  return (
    <FieldSet>
      <FieldLegend>What sends an Alert</FieldLegend>
      <p className="text-sm text-muted-foreground">Which hosts send Alerts, and for what, is chosen on the Routes page.</p>
      <FieldGroup className="gap-4">
        {groupTriggers(view).map((group) => (
          <div key={group.title} className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{group.title}</span>
            <div className="flex flex-col divide-y overflow-hidden rounded-lg border">
              {group.items.map((item) => (
                <Fragment key={item.key}>
                  <div className="flex items-center gap-3 px-3 py-2.5">
                    <Switch size="sm" checked={item.value} onCheckedChange={(value) => run(triggerBody(item.key, value))} aria-label={item.label} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm">{item.label}</span>
                      {item.description && <span className="text-xs text-muted-foreground">{item.description}</span>}
                    </div>
                    {item.overridden && (
                      <>
                        <Badge variant="outline">Changed</Badge>
                        <ResetButton onClick={() => run(triggerBody(item.key, null))} />
                      </>
                    )}
                  </div>
                  {item.key === "flapping" && <FlappingTiming view={view} save={save} />}
                </Fragment>
              ))}
            </div>
          </div>
        ))}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Reviews</span>
          <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm">A Review finds something at or above</span>
              <span className="text-xs text-muted-foreground">{REVIEW_LEVEL_HINT}</span>
            </div>
            {view.reviewLevel.overridden && (
              <>
                <Badge variant="outline">Changed</Badge>
                <ResetButton onClick={() => run(reviewLevelBody(null))} />
              </>
            )}
            <Select items={REVIEW_LEVEL_OPTIONS} value={view.reviewLevel.value} onValueChange={(value) => value && run(reviewLevelBody(value as ReviewLevel))}>
              <SelectTrigger className="w-32" aria-label="Level at which a Review sends an Alert">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {REVIEW_LEVEL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
        <ErrorLine message={error} />
      </FieldGroup>
    </FieldSet>
  )
}

/** The Alerts category of the settings: where messages go and what sends one. */
export function AlertSettingsPanel({ view, actions }: { view: AlertSettingsView; actions: ReturnType<typeof useAlertSettings> }) {
  return (
    <div className="flex flex-col gap-8">
      <Destinations view={view} actions={actions} />
      <Triggers view={view} save={actions.save} />
    </div>
  )
}
