/** The view of the alert settings the server returns, and the pure helpers around it. Copied, not imported, from the server. */

export type TriggerKey =
  | "cert"
  | "upstream"
  | "caddy"
  | "host"
  | "deploy_failed"
  | "external_edit"
  | "rollback"
  | "recovery"
  | "flapping"
export type TimingKey = "caddyHoldSec" | "upstreamHoldSec" | "flapChanges" | "flapStableMin"

export interface TopicView {
  id: string
  name: string
  source: "env" | "saved"
  enabled: boolean
  hasToken: boolean
  /** Only when login is on. */
  host?: string
}

export interface TimingView {
  value: number
  default: number
  overridden: boolean
  min: number
  max: number
}

export type HostKind = "cert" | "host" | "upstream"

export interface HostAlertView {
  enabled: boolean
  kinds: Record<HostKind, boolean>
  snoozedUntil: number | null
}

export interface HostAlertPatch {
  enabled?: boolean
  kinds?: Partial<Record<HostKind, boolean>>
  snoozeMinutes?: number | null
}

export interface AlertSettingsView {
  /** Only the hosts the Owner set something for; any other host sends no Alerts. */
  hosts?: Record<string, HostAlertView>
  canEditSecrets: boolean
  topics: TopicView[]
  publicUrl: { value: string | null; envDefault: string | null; overridden: boolean }
  triggers: Record<TriggerKey, { value: boolean; overridden: boolean }>
  timing: Record<TimingKey, TimingView>
}

export type SettingsReply = ({ ok: true } & AlertSettingsView & { id?: string }) | { ok: false; error: string }

export interface PutBody {
  triggers?: Partial<Record<TriggerKey, boolean | null>>
  timing?: Partial<Record<TimingKey, number | null>>
  publicUrl?: string | null
  hosts?: Record<string, HostAlertPatch | null>
}

export interface TopicForm {
  name: string
  url: string
  token: string
}

export const TRIGGER_GROUPS: Array<{
  title: string
  items: Array<{ key: TriggerKey; label: string; description?: string }>
}> = [
  {
    title: "Subjects",
    items: [
      { key: "cert", label: "A Certificate turns amber or red" },
      { key: "upstream", label: "An upstream goes down" },
      { key: "caddy", label: "Caddy stops answering" },
      { key: "host", label: "A host fails the host check" },
    ],
  },
  {
    title: "Events",
    items: [
      { key: "deploy_failed", label: "Caddy refuses a Deploy" },
      { key: "external_edit", label: "The Caddyfile is changed outside Fairway" },
      { key: "rollback", label: "A Rollback is done", description: "Off by default, you just did it." },
    ],
  },
  {
    title: "Messages",
    items: [
      { key: "recovery", label: "Tell me when something is back to normal" },
      { key: "flapping", label: "Send one message when something keeps changing", description: "Then stay quiet until it settles." },
    ],
  },
]

export const TIMING_FIELDS: Array<{ key: TimingKey; before: string; after: string; unit: [string, string] }> = [
  { key: "caddyHoldSec", before: "Caddy must fail to answer for", after: "before it counts as down", unit: ["second", "seconds"] },
  { key: "upstreamHoldSec", before: "An upstream must be unhealthy for", after: "before it counts as down", unit: ["second", "seconds"] },
  { key: "flapChanges", before: "More than", after: "within an hour is flapping", unit: ["change", "changes"] },
  { key: "flapStableMin", before: "Announce it as settled after", after: "without a change", unit: ["minute", "minutes"] },
]

export const unitFor = (field: (typeof TIMING_FIELDS)[number], count: number) => (count === 1 ? field.unit[0] : field.unit[1])

export type NumberParse = { ok: true; value: number } | { ok: false; error: string }

/** Reads a whole number out of an input and checks it against the server's limits. */
export function parseNumberField(text: string, min: number, max: number): NumberParse {
  const trimmed = text.trim()
  if (trimmed === "") return { ok: false, error: "Enter a number." }
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: "Use a whole number." }
  const value = Number(trimmed)
  if (value < min || value > max) return { ok: false, error: `Use a number from ${min} to ${max}.` }
  return { ok: true, value }
}

/** The Alert triggers in display order, with their current state. */
export function groupTriggers(view: Pick<AlertSettingsView, "triggers">) {
  return TRIGGER_GROUPS.map((group) => ({
    title: group.title,
    items: group.items.map((item) => ({ ...item, ...view.triggers[item.key] })),
  }))
}

export const triggerBody = (key: TriggerKey, value: boolean | null): PutBody => ({ triggers: { [key]: value } })
export const timingBody = (key: TimingKey, value: number | null): PutBody => ({ timing: { [key]: value } })
/** The empty string is sent as is: it means "no link", which is not the same as resetting. */
export const publicUrlBody = (text: string | null): PutBody => ({ publicUrl: text === null ? null : text.trim() })

/** The hint under a timing field: its default and its limits. */
export function describeTiming(field: (typeof TIMING_FIELDS)[number], view: TimingView): string {
  return `Default ${view.default} ${unitFor(field, view.default)}. Allowed ${view.min} to ${view.max}.`
}

export function describePublicUrl(view: AlertSettingsView["publicUrl"]): string {
  if (view.envDefault) return view.overridden ? `The environment sets ${view.envDefault}.` : `Taken from the environment: ${view.envDefault}.`
  return "Without it, messages carry no link."
}

/** The body for adding or changing a saved topic. Empty address and token mean "keep"; only a new topic needs an address. */
export function topicBody(form: TopicForm, mode: "add" | "edit") {
  const name = form.name.trim()
  const url = form.url.trim()
  const token = form.token.trim()
  if (name === "") return { ok: false as const, error: "Give the topic a name." }
  if (mode === "add" && url === "") return { ok: false as const, error: "Enter the topic address." }
  return {
    ok: true as const,
    body: { name, ...(url !== "" && { url }), ...(token !== "" && { token }) },
  }
}
