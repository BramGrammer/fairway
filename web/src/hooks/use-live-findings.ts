import { useEffect, useRef } from "react"

import { api, type ValidateResult } from "@/lib/api"
import type { Finding } from "@/lib/findings"
import { createLiveCheck } from "@/lib/live-check"

const QUIET_MS = 1000

/**
 * Validates `text` about a second after the last change and hands the Findings to `onFindings`
 * (an empty list when it is clean, or when the check failed, so no stale markers stay behind).
 * The first text is not checked: nothing was edited yet.
 */
export function useLiveFindings(text: string, onFindings: (findings: Finding[]) => void) {
  const callback = useRef(onFindings)
  useEffect(() => {
    callback.current = onFindings
  })
  const check = useRef<ReturnType<typeof createLiveCheck<Finding[]>> | null>(null)
  const first = useRef(true)

  useEffect(() => {
    check.current = createLiveCheck<Finding[]>({
      delay: QUIET_MS,
      run: async (sent) => {
        const { status, body } = await api<ValidateResult>("/api/validate", { text: sent })
        return status === 200 && Array.isArray(body.findings) ? body.findings : null
      },
      onResult: (result) => callback.current(result ?? []),
    })
    return () => check.current?.dispose()
  }, [])

  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    check.current?.input(text)
  }, [text])
}
