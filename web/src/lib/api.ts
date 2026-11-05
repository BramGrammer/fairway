export interface Reply<T = unknown> {
  status: number
  body: T
}

export async function api<T = unknown>(
  path: string,
  body?: unknown
): Promise<Reply<T>> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as T }
}

export interface Warning {
  file?: string
  line?: number
  message: string
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
  auth: { mode: "none" } | { mode: "tailscale"; user: string | null }
}

export type ValidateResult =
  | { ok: true; warnings: Warning[] }
  | { ok: false; error: string }

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
      warnings: Warning[]
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
