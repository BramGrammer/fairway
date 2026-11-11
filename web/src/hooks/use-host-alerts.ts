import { useEffect, useSyncExternalStore } from "react"

import { api } from "@/lib/api"
import type { AlertSettingsView, HostAlertPatch, HostAlertView, SettingsReply } from "@/lib/alert-settings"
import { hostAlertsOf } from "@/lib/host-alerts"

const POLL_MS = 60_000

// One request per page, however many bells and drawers are mounted: they share this store.
let snapshot: AlertSettingsView | null = null
let users = 0
let timer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

function publish(reply: SettingsReply) {
  if (!reply.ok) return
  const { ok: _ok, id: _id, ...view } = reply
  void _ok
  void _id
  snapshot = view
  listeners.forEach((listener) => listener())
}

function load() {
  if (document.visibilityState === "hidden") return
  api<SettingsReply>("/api/settings/alerts", undefined, { background: true })
    .then(({ body }) => publish(body))
    .catch(() => {})
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export type HostAlertsOutcome = { ok: true } | { ok: false; error: string }

async function update(host: string, patch: HostAlertPatch | null): Promise<HostAlertsOutcome> {
  try {
    const { status, body } = await api<SettingsReply>("/api/settings/alerts", { hosts: { [host]: patch } }, { method: "PUT" })
    if (body.ok) {
      publish(body)
      return { ok: true }
    }
    return { ok: false, error: body.error ?? `The server answered ${status}.` }
  } catch {
    return { ok: false, error: "Cannot reach the editor server." }
  }
}

/** Per-host Alert settings, loaded once and polled gently while at least one component uses them. */
export function useHostAlerts() {
  useEffect(() => {
    if (users++ === 0) {
      load()
      timer = setInterval(load, POLL_MS)
    }
    document.addEventListener("visibilitychange", load)
    return () => {
      document.removeEventListener("visibilitychange", load)
      if (--users === 0) clearInterval(timer)
    }
  }, [])
  const view = useSyncExternalStore(subscribe, () => snapshot)
  return {
    loaded: view !== null,
    /** True when some ntfy topic is switched on; without one nothing is sent. Unknown until loaded. */
    canAlert: view === null ? null : view.topics.some((topic) => topic.enabled),
    hostAlerts: (host: string): HostAlertView => hostAlertsOf(view?.hosts, host),
    update,
  }
}
