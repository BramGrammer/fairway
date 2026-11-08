import { useEffect, useState } from "react"

import { api } from "@/lib/api"
import { statesFrom, type TlsConfigReply, type TlsStates } from "@/lib/tls-config"

const NONE: TlsStates = new Map()

/** How every host is secured according to the configuration; it only changes with a deploy, so it is read once and then rarely. */
export function useTlsConfig(active: boolean, intervalMs = 300_000): TlsStates {
  const [states, setStates] = useState<TlsStates>(NONE)

  useEffect(() => {
    if (!active) return
    let stopped = false
    const load = () =>
      api<TlsConfigReply>("/api/tls")
        .then(({ body }) => {
          if (!stopped) setStates(statesFrom(body))
        })
        .catch(() => {
          if (!stopped) setStates(NONE)
        })
    void load()
    const timer = setInterval(load, intervalMs)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [active, intervalMs])

  return states
}
