import type { EventRecord, StateName } from "./events.js"
import { parsePersistedTable, type PersistedTableOf } from "./table-state.js"

export const EVENT_COLUMN_IDS = ["time", "type", "name", "status", "alert"] as const
export type EventColumnId = (typeof EVENT_COLUMN_IDS)[number]

/** What an event is about: a kind of Subject, or one of the one-shot occurrences. */
export type EventType = "caddy" | "host" | "cert" | "upstream" | "deploy" | "edit" | "rollback" | "review" | "fairway"

export const TYPE_LABELS: Record<EventType, string> = {
  caddy: "Caddy",
  host: "Host",
  cert: "Certificate",
  upstream: "Upstream",
  deploy: "Deploy",
  edit: "Outside edit",
  rollback: "Rollback",
  review: "Review",
  fairway: "Fairway",
}

const SUBJECT_TYPES = new Set<EventType>(["caddy", "host", "cert", "upstream"])

export function eventType(event: Pick<EventRecord, "kind" | "subject">): EventType {
  switch (event.kind) {
    case "deploy_failed":
      return "deploy"
    case "external_edit":
      return "edit"
    case "rollback":
      return "rollback"
    case "review_found":
    case "review_failed":
      return "review"
    case "gap":
      return "fairway"
  }
  const prefix = (event.subject ?? "").split(":", 1)[0] as EventType
  return SUBJECT_TYPES.has(prefix) ? prefix : "fairway"
}

/** The name of the Subject without its kind: a host, a certificate's host, an upstream's address. Empty when there is none. */
export function eventName(event: Pick<EventRecord, "subject"> & { review?: { id: number } }): string {
  if (event.review) return `Review ${event.review.id}`
  const subject = event.subject ?? ""
  const at = subject.indexOf(":")
  return at === -1 ? "" : subject.slice(at + 1)
}

const pad = (n: number) => String(n).padStart(2, "0")
const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

/** The time of day, 24 hours, with the day in front of it unless it is today: "14:32", "Yesterday 14:32", "Nov 9, 14:32". */
export function clockLabel(at: number, now: number): string {
  const date = new Date(at)
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const days = Math.round((dayStart(new Date(now)) - dayStart(date)) / 86_400_000)
  if (days <= 0) return time
  if (days === 1) return `Yesterday ${time}`
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`
}

const STATE_RANK: Record<StateName, number> = { ok: 1, warning: 2, down: 3 }

/** For sorting the status column: the worse the new State, the higher; events that are not State changes come first. */
export function statusRank(event: Pick<EventRecord, "kind" | "state">): number {
  return event.kind === "state" && event.state ? STATE_RANK[event.state] : 0
}

export const sortKeys = {
  time: (event: EventRecord) => event.at,
  type: (event: EventRecord) => TYPE_LABELS[eventType(event)],
  name: (event: EventRecord) => eventName(event).toLowerCase(),
  status: (event: EventRecord) => statusRank(event),
  alert: (event: EventRecord) => event.delivery ?? "",
}

/** Newest first, until the Owner picks another order. */
export const DEFAULT_SORTING = [{ id: "time", desc: true }]

export function parsePersistedEvents(raw: string | null): PersistedTableOf<EventColumnId> {
  return parsePersistedTable(raw, EVENT_COLUMN_IDS)
}
