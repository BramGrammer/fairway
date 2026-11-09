import { useEffect, useState } from "react"

import { api } from "@/lib/api"
import type { TlsStatusReply } from "@/lib/tls-badges"

/** Polls the server's TLS sweep results while `active`. The sweep itself runs every 6 hours, so this is cheap. */
export function useTlsStatus(active: boolean, intervalMs = 60_000) {
  const [reply, setReply] = useState<TlsStatusReply | null>(null)

  useEffect(() => {
    if (!active) return
    let stopped = false
    const poll = () => {
      if (document.visibilityState === "hidden") return
      api<TlsStatusReply>("/api/tls/status", undefined, { background: true })
        .then(({ body }) => {
          if (!stopped) setReply(body)
        })
        .catch(() => {
          if (!stopped) setReply(null)
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
