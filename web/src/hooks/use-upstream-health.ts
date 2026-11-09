import { useEffect, useState } from "react"

import { api } from "@/lib/api"
import type { UpstreamsReply } from "@/lib/upstream-health"

/** Polls Caddy's upstream health while `active`, pausing when the browser tab is hidden. */
export function useUpstreamHealth(active: boolean, intervalMs = 5000) {
  const [reply, setReply] = useState<UpstreamsReply | null>(null)

  useEffect(() => {
    if (!active) return
    let stopped = false
    const poll = () => {
      if (document.visibilityState === "hidden") return
      api<UpstreamsReply>("/api/upstreams", undefined, { background: true })
        .then(({ body }) => {
          if (!stopped) setReply(body)
        })
        .catch(() => {
          if (!stopped) setReply({ ok: false, error: "Cannot reach the editor server." })
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
  }, [active, intervalMs])

  return reply
}
