import type { HostLogLine, HostLogReply } from "./api"

export type StatusTone = "success" | "redirect" | "client-error" | "server-error" | "none"

export interface HostLogRow {
  time: string
  status: string
  tone: StatusTone
  method: string
  path: string
  client: string
  duration: string
  size: string
}

const pad = (n: number) => String(n).padStart(2, "0")

/** Local time of day, `HH:MM:SS`. */
export function formatLogTime(ms: number | null): string {
  if (ms === null) return "-"
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Seconds as Caddy logs them, shown as ms below a second and seconds above. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "-"
  if (seconds >= 1) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`
  return `${Math.round(seconds * 1000)} ms`
}

export function formatSize(bytes: number | null): string {
  if (bytes === null) return "-"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function statusTone(status: number | null): StatusTone {
  if (status === null) return "none"
  if (status >= 500) return "server-error"
  if (status >= 400) return "client-error"
  if (status >= 300) return "redirect"
  return "success"
}

export function formatLogRow(line: HostLogLine): HostLogRow {
  return {
    time: formatLogTime(line.time),
    status: line.status === null ? "-" : String(line.status),
    tone: statusTone(line.status),
    method: line.method || "-",
    path: line.uri || "/",
    client: line.client || "-",
    duration: formatDuration(line.duration),
    size: formatSize(line.size),
  }
}

type Failure = Extract<HostLogReply, { ok: false }>

/** A plain-language explanation of why a host has no readable log. */
export function describeLogFailure(reply: Failure, host: string): { title: string; text: string } {
  switch (reply.reason) {
    case "no-file-writer":
      return {
        title: "Not logged to a file",
        text: `${host} logs to ${reply.output}, not to a file, so Fairway cannot read it. Point its log at a file in the mounted log folder.`,
      }
    case "missing-file":
      return {
        title: "Log file not found",
        text: `Fairway expected ${reply.file} in its log folder but did not find it. Caddy writes it to ${reply.configuredPath}: the file appears once ${host} has served a request, and that folder must be the one Fairway has mounted.`,
      }
    case "not-logged":
      return {
        title: "Requests are not logged",
        text: `${host} does not write access logs, so there is nothing to show.`,
      }
    default:
      return { title: "Cannot read the log", text: reply.error }
  }
}
