/** Per-host Alert settings: defaults, snooze wording, the bell state and the PUT bodies. */
import type { HostAlertView, HostKind } from "./alert-settings"

export const HOST_KINDS: Array<{ key: HostKind; label: string; description: string }> = [
  { key: "cert", label: "Certificate", description: "Certificate turns amber or red" },
  { key: "host", label: "Host check", description: "The host check finds it failing (needs HOST_CHECK)" },
  { key: "upstream", label: "Upstreams", description: "An upstream it uses goes down" },
]

export const SNOOZE_OPTIONS = [
  { minutes: 60, label: "Snooze 1 hour" },
  { minutes: 24 * 60, label: "Snooze 24 hours" },
] as const

/** A host the Owner set nothing for sends no Alerts. */
export const DEFAULT_HOST_ALERTS: HostAlertView = {
  enabled: false,
  kinds: { cert: true, host: true, upstream: true },
  snoozedUntil: null,
}

export function hostAlertsOf(hosts: Record<string, HostAlertView> | undefined, host: string): HostAlertView {
  const found = hosts && Object.hasOwn(hosts, host) ? hosts[host] : undefined
  return found ? { ...found, kinds: { ...DEFAULT_HOST_ALERTS.kinds, ...found.kinds } } : DEFAULT_HOST_ALERTS
}

export const isSnoozed = (alerts: Pick<HostAlertView, "snoozedUntil">, now: number = Date.now()) =>
  alerts.snoozedUntil !== null && alerts.snoozedUntil > now

/** "14:30" for today, "Thu 14:30" otherwise. */
export function formatSnoozeEnd(until: number, now: number = Date.now()): string {
  const at = new Date(until)
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
  return at.toDateString() === new Date(now).toDateString()
    ? time
    : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`
}

export const describeSnooze = (until: number, now: number = Date.now()) => `Snoozed until ${formatSnoozeEnd(until, now)}`

export type BellState = "on" | "snoozed" | "off"

export function bellState(alerts: HostAlertView, now: number = Date.now()): BellState {
  if (!alerts.enabled) return "off"
  return isSnoozed(alerts, now) ? "snoozed" : "on"
}

export function describeBell(alerts: HostAlertView, now: number = Date.now()): string {
  const state = bellState(alerts, now)
  if (state === "on") return "Alerts on"
  if (state === "off") return "Alerts off"
  return `Alerts snoozed until ${formatSnoozeEnd(alerts.snoozedUntil as number, now)}`
}
