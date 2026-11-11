import { useCallback, useEffect, useState } from "react"

import { api } from "@/lib/api"
import type { AlertSettingsView, PutBody, SettingsReply } from "@/lib/alert-settings"

export type Outcome = { ok: true; id?: string } | { ok: false; error: string }

/** Loads the alert settings when mounted and replaces them with every view the server returns. */
export function useAlertSettings() {
  const [view, setView] = useState<AlertSettingsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const apply = useCallback((reply: SettingsReply, status: number): Outcome => {
    if (reply.ok) {
      const { ok: _ok, id, ...next } = reply
      void _ok
      setView(next)
      return { ok: true, id }
    }
    return { ok: false, error: reply.error ?? `The server answered ${status}.` }
  }, [])

  const request = useCallback(
    async (path: string, method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE", body?: unknown): Promise<Outcome> => {
      try {
        const { status, body: reply } = await api<SettingsReply>(path, body, { method })
        return apply(reply, status)
      } catch {
        return { ok: false, error: "Cannot reach the editor server." }
      }
    },
    [apply]
  )

  const load = useCallback(async () => {
    const outcome = await request("/api/settings/alerts", "GET")
    setLoadError(outcome.ok ? null : outcome.error)
  }, [request])

  useEffect(() => {
    let stopped = false
    api<SettingsReply>("/api/settings/alerts")
      .then(({ status, body }) => {
        if (stopped) return
        const outcome = apply(body, status)
        setLoadError(outcome.ok ? null : outcome.error)
      })
      .catch(() => {
        if (!stopped) setLoadError("Cannot reach the editor server.")
      })
    return () => {
      stopped = true
    }
  }, [apply])

  return {
    view,
    loadError,
    reload: load,
    save: (body: PutBody) => request("/api/settings/alerts", "PUT", body),
    addTopic: (body: { name: string; url: string; token?: string }) => request("/api/settings/alerts/topics", "POST", body),
    updateTopic: (id: string, body: { name?: string; url?: string; token?: string | null; enabled?: boolean }) =>
      request(`/api/settings/alerts/topics/${encodeURIComponent(id)}`, "PATCH", body),
    removeTopic: (id: string) => request(`/api/settings/alerts/topics/${encodeURIComponent(id)}`, "DELETE"),
  }
}
