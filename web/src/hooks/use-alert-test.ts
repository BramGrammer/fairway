import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { AlertTestReply } from "@/lib/events"

/** Sends one marked test Alert and keeps its outcome. With a topic id it tests only that topic. */
export function useAlertTest(topicId?: string) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<AlertTestReply | null>(null)

  const send = useCallback(async () => {
    setTesting(true)
    setResult(null)
    try {
      setResult((await api<AlertTestReply>("/api/alerts/test", topicId ? { id: topicId } : {})).body)
    } catch {
      setResult({ ok: false, error: "Cannot reach the editor server." })
    }
    setTesting(false)
  }, [topicId])

  return { testing, result, send }
}
