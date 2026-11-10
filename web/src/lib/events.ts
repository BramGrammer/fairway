export type StateName = "ok" | "warning" | "down"
export type EventKind = "state" | "gap" | "removed" | "flapping" | "deploy_failed" | "external_edit" | "rollback"
export type Delivery = "sent" | "failed" | "pending"

export interface EventRecord {
  id: number
  /** When it happened, in ms. */
  at: number
  kind: EventKind
  /** `caddy`, `cert:<host>`, `upstream:<address>` or `host:<name>`; absent for one-shot events. */
  subject?: string
  state?: StateName
  previous?: StateName | null
  /** End of a gap, in ms. */
  until?: number
  message: string
  delivery?: Delivery
}

export type EventsReply = { ok: true; alerts: boolean; events: EventRecord[] } | { ok: false; error?: string }
export type AlertsReply = { ok: true; enabled: boolean } | { ok: false; error?: string }
export type AlertTestReply = { ok: true } | { ok: false; error: string }

export const EVENT_STATE_LABELS: Record<StateName, string> = { ok: "Up", warning: "Degraded", down: "Down" }

/** The distinct subjects in the list, sorted. */
export function subjectsOf(events: EventRecord[]): string[] {
  return [...new Set(events.flatMap((event) => (event.subject ? [event.subject] : [])))].sort()
}

/** Subject filter: "all" keeps everything, otherwise only events of that subject. */
export function filterBySubject(events: EventRecord[], subject: string): EventRecord[] {
  return subject === "all" ? events : events.filter((event) => event.subject === subject)
}

export function subjectLabel(subject: string): string {
  return subject.replace(":", " ")
}
