import type { HostLogLine } from "./api"
import { statusTone, type StatusTone } from "./host-log-rows"

const TLS_VERSIONS: Record<string, string> = {
  "769": "TLS 1.0",
  "770": "TLS 1.1",
  "771": "TLS 1.2",
  "772": "TLS 1.3",
}

export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "other"

export interface LogFilter {
  /** Status classes to keep; empty keeps every class. */
  classes: ReadonlySet<StatusClass>
  /** Matched case-insensitively against uri, client address and user agent; blank keeps every line. */
  query: string
}

export interface DetailEntry {
  label: string
  value: string
}

const CLASS_BY_TONE: Record<StatusTone, StatusClass> = {
  success: "2xx",
  redirect: "3xx",
  "client-error": "4xx",
  "server-error": "5xx",
  none: "other",
}

/** The class of a status code. Colour comes from `statusTone`; 1xx and missing codes are "other". */
export function statusClass(status: number | null): StatusClass {
  if (status !== null && status < 200) return "other"
  return CLASS_BY_TONE[statusTone(status)]
}

export function filterLines(lines: HostLogLine[], filter: LogFilter): HostLogLine[] {
  const query = filter.query.trim().toLowerCase()
  return lines.filter((line) => {
    if (filter.classes.size > 0 && !filter.classes.has(statusClass(line.status))) return false
    if (query === "") return true
    return [line.uri, line.client, line.userAgent].some((text) => text.toLowerCase().includes(query))
  })
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const scalar = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : ""

function headerEntries(prefix: string, headers: unknown): DetailEntry[] {
  return Object.entries(asRecord(headers)).flatMap(([name, value]) => {
    const text = Array.isArray(value) ? value.map(scalar).filter(Boolean).join(", ") : scalar(value)
    return text === "" ? [] : [{ label: `${prefix} ${name}`, value: text }]
  })
}

/**
 * Label/value pairs for the expanded view of a line, read from its raw Caddy
 * entry. Order: request, user agent, protocol, TLS, request headers, response
 * headers, duration, size. Anything missing is left out.
 */
export function expandedDetails(line: HostLogLine): DetailEntry[] {
  const raw = asRecord(line.raw)
  const request = asRecord(raw.request)
  const tls = asRecord(request.tls)
  const requestHeaders = asRecord(request.headers)
  const userAgentHeader = Object.entries(requestHeaders).find(([name]) => name.toLowerCase() === "user-agent")?.[1]
  const userAgent = line.userAgent || (Array.isArray(userAgentHeader) ? scalar(userAgentHeader[0]) : scalar(userAgentHeader))

  const entries: Array<[string, string]> = [
    ["Method", scalar(request.method) || line.method],
    ["Host", scalar(request.host) || line.host],
    ["URI", scalar(request.uri) || line.uri],
    ["User agent", userAgent],
    ["Protocol", scalar(request.proto)],
    ["TLS version", scalar(TLS_VERSIONS[String(tls.version)] ?? tls.version)],
    ["TLS cipher suite", scalar(tls.cipher_suite)],
    ["TLS server name", scalar(tls.server_name)],
    ["TLS protocol", scalar(tls.proto)],
  ]
  const fixed = (list: Array<[string, string]>): DetailEntry[] =>
    list.filter(([, value]) => value !== "").map(([label, value]) => ({ label, value }))

  const duration = scalar(raw.duration) || (line.duration === null ? "" : String(line.duration))
  const size = scalar(raw.size) || (line.size === null ? "" : String(line.size))

  return [
    ...fixed(entries),
    ...headerEntries("Request header", requestHeaders),
    ...headerEntries("Response header", raw.resp_headers),
    ...fixed([
      ["Duration", duration === "" ? "" : `${duration} s`],
      ["Size", size === "" ? "" : `${size} B`],
    ]),
  ]
}
