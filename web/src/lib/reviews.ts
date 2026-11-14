/** The Reviews the server returns, and the pure helpers around them. Copied, not imported, from the server. */
import { statusClass } from "./host-log-filter"
import { rangeCovering } from "./host-log-query"
import { buildUrl, type Params } from "./router"
import { siteNodeId } from "./route-drawer"
import { parsePersistedTable, type PersistedTableOf } from "./table-state.js"

export const LEVELS = ["urgent", "notable", "info"] as const
export type Level = (typeof LEVELS)[number]

export const LEVEL_LABELS: Record<Level, string> = { urgent: "Urgent", notable: "Notable", info: "Info" }

export interface Evidence {
  client?: string
  path?: string
  status?: number
  count?: number
  period?: string
}

export interface Observation {
  level: Level
  sites: string[]
  title: string
  explanation: string
  evidence: Evidence[]
  /** The same thing the previous Review reported, continuing. Absent in older Reviews. */
  ongoing?: boolean
}

export type UnseenReason = "rotated-away" | "size-limit" | "read-error"
export type SkipReason = "not-logged" | "no-file-writer" | "missing-file" | "no-host"

export interface UnseenPart {
  from: number
  to: number
  reason: UnseenReason
  file: string
}

export interface LinesRequested {
  request: { host: string; from: number; to: number; status?: Array<number | string>; pathPrefix?: string; client?: string; limit: number; view?: "summary" | "rows" }
  rows: number
}

/** One line of the "Lines looked at" list, plain text. */
export function linesRequestedLabel({ request, rows }: LinesRequested): string {
  const stamp = (at: number) => new Date(at).toLocaleString()
  const parts = [request.host, `${stamp(request.from)} to ${stamp(request.to)}`]
  if (request.status?.length) parts.push(`status ${request.status.join(", ")}`)
  if (request.pathPrefix) parts.push(`path ${request.pathPrefix}`)
  if (request.client) parts.push(`client ${request.client}`)
  if (request.view === "summary") return `${parts.join(", ")}: summary of ${rows} ${rows === 1 ? "line" : "lines"}`
  return `${parts.join(", ")}: ${rows} ${rows === 1 ? "row" : "rows"}`
}

export interface Review {
  id: number
  startedAt: number
  finishedAt: number | null
  period: { from: number; to: number }
  status: "running" | "done" | "failed"
  /** How it began; absent in older Reviews, which count as manual. */
  trigger?: "schedule" | "manual" | "retry"
  failure: string | null
  summary: string | null
  observations: Observation[]
  coverage: {
    sites: Array<{ site: string; unseen: UnseenPart[] }>
    skipped: Array<{ site: string; hosts: string[]; reason: SkipReason }>
    /** Time before the period that no Review covered. Absent in older Reviews. */
    gaps?: Array<{ from: number; to: number; reason: "no-review" }>
    /** How much of the period's end Caddy still had lines for, at the Site that kept the least. Absent when nothing was rotated away. */
    retainedMs?: number
  }
  /** The requests for log lines the model made; absent on Reviews stored before this existed. */
  linesRequested?: LinesRequested[]
  model: string
  usage: { promptTokens: number; completionTokens: number } | null
}

export interface ReviewSchedule {
  interval: "off" | "6h" | "12h" | "24h" | "weekly"
  active: boolean
  idleReason: string | null
  /** When the next Review is due; null when the schedule is not active. */
  nextAt: number | null
  /** True when `nextAt` is the retry of a failed Review. Absent from older servers. */
  retrying?: boolean
}

export type ReviewsReply = { ok: true; running: boolean; reviews: Review[]; schedule?: ReviewSchedule } | { ok: false; error?: string }

/** When the next Review is due, for the toolbar: "Next Review in about 5 hours". */
export function nextReviewLabel(schedule: ReviewSchedule, now: number): string {
  if (schedule.interval === "off") return "Scheduled Reviews are off"
  if (!schedule.active || schedule.nextAt === null) return `Scheduled Reviews are idle${schedule.idleReason ? `: ${schedule.idleReason}` : ""}`
  const lead = schedule.retrying ? "Retrying" : "Next Review"
  const minutes = Math.ceil((schedule.nextAt - now) / 60_000)
  if (minutes <= 1) return schedule.retrying ? "Retrying now" : "Next Review is due now"
  if (minutes < 60) return `${lead} in about ${minutes} minutes`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${lead} in about ${hours} ${hours === 1 ? "hour" : "hours"}`
  const days = Math.round(hours / 24)
  return `${lead} in about ${days} days`
}
export type StartReviewReply = { ok: true; review: Review } | { ok: false; error: string }

export const REVIEW_COLUMN_IDS = ["started", "period", "observations", "tokens", "status"] as const
export type ReviewColumnId = (typeof REVIEW_COLUMN_IDS)[number]

/** How many Observations a Review has at each level. */
export function countByLevel(observations: Observation[]): Record<Level, number> {
  const counts: Record<Level, number> = { urgent: 0, notable: 0, info: 0 }
  for (const observation of observations) counts[observation.level] += 1
  return counts
}

/** Observations grouped by level, most urgent first; levels without any are left out. */
export function groupByLevel(observations: Observation[]): Array<{ level: Level; observations: Observation[] }> {
  return LEVELS.map((level) => ({ level, observations: observations.filter((o) => o.level === level) })).filter((group) => group.observations.length > 0)
}

export function totalTokens(usage: Review["usage"]): number | null {
  return usage ? usage.promptTokens + usage.completionTokens : null
}

/** A token count for a table cell: "1,280". */
export const formatTokens = (count: number) => count.toLocaleString("en-US")

const pad = (n: number) => String(n).padStart(2, "0")
const stamp = (at: number) => {
  const d = new Date(at)
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The period of a Review: "Nov 11, 14:32 to Nov 12, 14:32". */
export function periodLabel(period: { from: number; to: number }): string {
  return `${stamp(period.from)} to ${stamp(period.to)}`
}

export const stampLabel = stamp

export const UNSEEN_REASONS: Record<UnseenReason, string> = {
  "rotated-away": "Caddy had already rotated these lines away",
  "size-limit": "Reading stopped at the size limit",
  "read-error": "A log file could not be read to its end",
}

/** Several Sites with the same part of the period unseen for the same reason, as one entry. */
export function groupUnseen<T extends { site: string; from: number; to: number; reason: UnseenReason }>(parts: T[]): Array<{ sites: string[]; from: number; to: number; reason: UnseenReason }> {
  const groups = new Map<string, { sites: string[]; from: number; to: number; reason: UnseenReason }>()
  for (const part of parts) {
    const key = `${part.reason}|${part.from}|${part.to}`
    const group = groups.get(key)
    if (group) group.sites.push(part.site)
    else groups.set(key, { sites: [part.site], from: part.from, to: part.to, reason: part.reason })
  }
  return [...groups.values()]
}

/**
 * A notice when Caddy kept clearly less of the log than the Review covered: "Caddy kept about 8 hours of log, but this
 * Review covered 25 hours." Null when it kept enough, or nothing was rotated away. The margin keeps a few minutes' gap quiet.
 */
export function retentionNotice(review: { period: { from: number; to: number }; coverage: { retainedMs?: number } }): string | null {
  const retained = review.coverage.retainedMs
  const covered = review.period.to - review.period.from
  if (retained === undefined || retained >= covered - 30 * 60_000) return null
  const hours = (ms: number) => {
    const value = Math.max(1, Math.round(ms / 3_600_000))
    return `${value} ${value === 1 ? "hour" : "hours"}`
  }
  return `Caddy kept only about ${hours(retained)} of log, but this Review covered ${hours(covered)}. Run Reviews more often than that, or let Caddy keep more log files.`
}

export const SKIP_REASONS: Record<SkipReason, string> = {
  "not-logged": "no Access log is set for it",
  "no-file-writer": "its log does not go to a file",
  "missing-file": "its log file is missing",
  "no-host": "it has no host name",
}

export const STATUS_LABELS: Record<Review["status"], string> = { running: "Running", done: "Done", failed: "Failed" }

/** One line for a piece of evidence: "203.0.113.9 · /.env · 404 · 12 requests". */
export function evidenceLine(evidence: Evidence): string {
  const parts: string[] = []
  if (evidence.client !== undefined) parts.push(evidence.client)
  if (evidence.path !== undefined) parts.push(evidence.path)
  if (evidence.status !== undefined) parts.push(String(evidence.status))
  if (evidence.count !== undefined) parts.push(`${evidence.count} ${evidence.count === 1 ? "request" : "requests"}`)
  if (evidence.period !== undefined) parts.push(evidence.period)
  return parts.join(" · ")
}

/** The most evidence lines of one observation that go into a message to the Assistant. */
const PROMPT_EVIDENCE = 3
/** The most characters of a message to the Assistant, so a long Review does not make a Conversation too big to continue. */
const PROMPT_LIMIT = 6000

/**
 * The message that asks the Assistant to propose Caddyfile changes for what a Review found. Null when the Review
 * found nothing to act on. What the Review reported is text from the model, passed on as the Owner's message.
 */
export function reviewFixPrompt(review: Review): string | null {
  if (review.status !== "done" || review.observations.length === 0) return null
  const lines = groupByLevel(review.observations).flatMap((group) =>
    group.observations.map((observation) => {
      const where = observation.sites.length > 0 ? ` (${observation.sites.join(", ")})` : ""
      const evidence = observation.evidence.slice(0, PROMPT_EVIDENCE).map((item) => `  - ${evidenceLine(item)}`)
      return [`- ${LEVEL_LABELS[group.level]}: ${observation.title}${where}`, `  ${observation.explanation.replace(/\s+/g, " ").trim()}`, ...evidence].join("\n")
    })
  )
  const intro = `A Review of the access logs from ${periodLabel(review.period)} found the following. Propose changes to the Caddyfile that fix what a Caddyfile change can fix. For anything it cannot fix, say so in a sentence and why.`
  const text = `${intro}\n\n${lines.join("\n")}`
  return text.length <= PROMPT_LIMIT ? text : `${text.slice(0, PROMPT_LIMIT - 1).trimEnd()}…`
}

export const sortKeys = {
  started: (review: Review) => review.startedAt,
  period: (review: Review) => review.period.to,
  observations: (review: Review) => {
    const c = countByLevel(review.observations)
    return c.urgent * 1_000_000 + c.notable * 1_000 + c.info
  },
  tokens: (review: Review) => totalTokens(review.usage) ?? -1,
  status: (review: Review) => review.status,
}

/** Newest first, until the Owner picks another order. */
export const DEFAULT_SORTING = [{ id: "started", desc: true }]

export function parsePersistedReviews(raw: string | null): PersistedTableOf<ReviewColumnId> {
  return parsePersistedTable(raw, REVIEW_COLUMN_IDS)
}

/** Whether the Reviews page is offered: the Reviews model is set, and the Owner has a login. */
export function reviewsAvailable(ready: boolean | undefined, loginRequired: boolean): boolean {
  return ready === true && loginRequired
}

// ---- links from Observations to the Logs tab ----


/** The Site of the running config that answers for `host`, or undefined when it no longer exists. */
export function findSite<S extends { hosts: string[] }>(sites: S[], host: string): S | undefined {
  const wanted = host.trim().toLowerCase()
  return sites.find((site) => site.hosts.some((name) => name.toLowerCase() === wanted))
}

/**
 * The routes page URL that opens a Site's drawer on its Logs tab with the filters of one piece of evidence: its client,
 * its path as a prefix, its status as a class, and the smallest time range that reaches the end of the Review's period.
 * With no evidence only the range is set.
 */
export function logsParams(site: { hosts: string[]; listen: string[] }, review: Pick<Review, "period">, now: number, evidence?: Evidence): Params {
  const params: Params = { node: siteNodeId(site), tab: "logs" }
  const client = evidence?.client?.trim()
  if (client && client.length <= 100) params.client = client
  const path = evidence?.path?.trim()
  // The server matches a prefix of the request path, so only a path that is one can be carried.
  if (path && path.startsWith("/") && path.length <= 500) params.path = path
  const status = evidence?.status
  if (typeof status === "number") {
    const klass = statusClass(status)
    if (klass !== "other") params.status = klass
  }
  const range = rangeCovering(review.period.to, now)
  if (range) params.range = range
  return params
}

export const logsUrl = (params: Params) => buildUrl("routes", params)
