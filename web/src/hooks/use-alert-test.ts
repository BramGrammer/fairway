import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { AlertTestReply } from "@/lib/events"

/** Sends one marked test Alert and keeps its outcome, for the Events tab and the settings. */
export function useAlertTest() {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<AlertTestReply | null>(null)

  const send = useCallback(async () => {
    setTesting(true)
    setResult(null)
    try {
      setResult((await api<AlertTestReply>("/api/alerts/test", {})).body)
    } catch {
      setResult({ ok: false, error: "Cannot reach the editor server." })
    }
    setTesting(false)
  }, [])

  return { testing, result, send }
}
