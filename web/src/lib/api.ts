import type { Finding } from "@/lib/findings"
import { isSessionLost, type AuthStatus } from "@/lib/auth"

export interface Reply<T = unknown> {
  status: number
  body: T
}

type SessionLostListener = () => void
const sessionLostListeners = new Set<SessionLostListener>()

/** Called when any API call finds the session gone. Returns the unsubscribe. */
export function onSessionLost(listener: SessionLostListener) {
  sessionLostListeners.add(listener)
  return () => {
    sessionLostListeners.delete(listener)
  }
}

function sessionLost() {
  sessionLostListeners.forEach((listener) => listener())
}

export async function api<T = unknown>(
  path: string,
  body?: unknown,
  options: { background?: boolean; method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" } = {}
): Promise<Reply<T>> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers["Content-Type"] = "application/json"
  // Periodic polls must not keep a forgotten tab signed in: the server does not renew the session for these.
  if (options.background) headers["X-Fairway-Background"] = "1"
  const response = await fetch(path, {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (isSessionLost(path, response.status)) sessionLost()
  return { status: response.status, body: (await response.json().catch(() => ({}))) as T }
}

/** An EventSource that re-checks the sign-in status when it errors, since a 401 gives no detail. */
export function openStream(url: string): EventSource {
  const source = new EventSource(url)
  source.addEventListener("error", () => {
    void api<AuthStatus>("/api/auth/status").then(({ status, body }) => {
      if (status === 200 && body.mode === "login" && !body.signedIn) sessionLost()
    }, () => {})
  })
  return source
}

export type RevisionId = number | "original"

export interface RevisionMeta {
  id: number
  createdAt: string
  hash: string
  kind: "deployed" | "external"
  note: string
  rollbackOf?: RevisionId
}

export interface StatusInfo {
  caddyReachable: boolean
  auth: { mode: "none" | "login" }
}

export type { AuthStatus }

/** Caddy rejected the Caddyfile when `ok` is false; Deploy refuses then. */
export interface ValidateResult {
  ok: boolean
  findings: Finding[]
}

export type FormatResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; error: string }

export interface Chip {
  label: string
  detail?: string
}

export interface Destination {
  kind: "proxy" | "file" | "redirect" | "respond" | "other"
  summary: string
  upstreams?: string[]
  status?: number
  target?: string
}

export interface Rule {
  match: string
  /** The same condition as `match`, in parts: a short label for a table cell and the full text as detail. */
  matchers?: Chip[]
  destinations: Destination[]
  middleware: Chip[]
}

export interface Site {
  hosts: string[]
  listen: string[]
  middleware: Chip[]
  rules: Rule[]
}

export type RoutesReply =
  | { ok: true; source: "running" | "editor"; sites: Site[] }
  | { ok: false; error: string }

export type DeployResult =
  | {
      ok: true
      revision: RevisionMeta
      unchanged: boolean
      hash: string
      findings: Finding[]
    }
  | {
      ok: false
      code: "conflict" | "invalid" | "load_failed" | "restore_failed"
      message: string
      currentText?: string
      currentHash?: string
    }

export interface CaddyfileState {
  text: string
  hash: string
}

export function describeFailure(result: Extract<DeployResult, { ok: false }>) {
  switch (result.code) {
    case "invalid":
      return "Not deployed: Caddy rejected this Caddyfile."
    case "load_failed":
      return "Not deployed: Caddy refused the reload. The previous file was restored and Caddy is still running the old config."
    case "restore_failed":
      return "Not deployed, and the previous file could not be restored. Check the Caddyfile on disk."
    default:
      return "Not deployed."
  }
}

export interface HostStats {
  requests: number
  codes: { "2xx": number; "3xx": number; "4xx": number; "5xx": number; other: number }
  bytes: number
  avgMs: number
  inFlight: number
  rate: number
  history: number[]
}

export type MetricsReply =
  | {
      ok: true
      enabled: boolean
      perHost: boolean
      windowMs: number
      coveredMs: number
      hosts: Record<string, HostStats>
    }
  | { ok: false; error: string }

export interface HostLogLine {
  time: number | null
  status: number | null
  method: string
  host: string
  uri: string
  client: string
  duration: number | null
  size: number | null
  userAgent: string
  raw: Record<string, unknown>
}

export type HostLogReply =
  /** `incomplete`: reading stopped at its byte bound before enough lines matched, so older lines may match too. */
  | { ok: true; file: string; lines: HostLogLine[]; incomplete: boolean }
  | { ok: false; reason: "no-file-writer"; output: string }
  | { ok: false; reason: "missing-file"; file: string; configuredPath: string }
  | { ok: false; reason: "not-logged" }
  /** Caddy could not be reached (no `reason`). */
  | { ok: false; reason?: undefined; error: string }

const hostQuery = (host: string, filter: URLSearchParams): string => new URLSearchParams([["host", host], ...filter]).toString()

/** The recent access log lines of one host, read live from the running config. */
export async function fetchHostLogs(host: string, filter: URLSearchParams = new URLSearchParams()): Promise<HostLogReply> {
  try {
    const { body } = await api<HostLogReply>(`/api/host-logs?${hostQuery(host, filter)}`)
    return body
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

/** Opens the live tail of a host's log. Data events are JSON arrays of lines; an `end` event means reload. */
export function openHostLogStream(host: string, filter: URLSearchParams = new URLSearchParams()): EventSource {
  return openStream(`/api/host-logs/stream?${hostQuery(host, filter)}`)
}
