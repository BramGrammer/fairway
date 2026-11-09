import { useEffect, useState } from "react"

import { api, type MetricsReply } from "@/lib/api"

/** Polls the editor's metrics sampler while `active`, pausing when the browser tab is hidden. */
export function useMetrics(active: boolean, windowSeconds: number, intervalMs = 5000) {
  const [metrics, setMetrics] = useState<MetricsReply | null>(null)

  useEffect(() => {
    if (!active) return
    let stopped = false
    const poll = () => {
      if (document.visibilityState === "hidden") return
      api<MetricsReply>(`/api/metrics?window=${windowSeconds}`, undefined, { background: true })
        .then(({ body }) => {
          if (!stopped) setMetrics(body)
        })
        .catch(() => {
          if (!stopped) setMetrics({ ok: false, error: "Cannot reach the editor server." })
        })
    }
    poll()
    const timer = setInterval(poll, intervalMs)
    document.addEventListener("visibilitychange", poll)
    return () => {
      stopped = true
      clearInterval(timer)
      document.removeEventListener("visibilitychange", poll)
    }
  }, [active, windowSeconds, intervalMs])

  return metrics
}
