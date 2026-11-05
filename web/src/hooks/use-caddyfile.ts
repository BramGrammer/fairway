import { useCallback, useEffect, useState } from "react"

import { api, type CaddyfileState } from "@/lib/api"

/** The Caddyfile as last read from disk (`base`) and the text being edited. */
export function useCaddyfile() {
  const [base, setBase] = useState<CaddyfileState | null>(null)
  const [text, setText] = useState("")
  const [error, setError] = useState(false)

  const apply = useCallback((state: CaddyfileState) => {
    setBase(state)
    setText(state.text)
    setError(false)
  }, [])

  /** Re-reads the file from disk, discarding unsaved edits. */
  const load = useCallback(async () => {
    try {
      apply((await api<CaddyfileState>("/api/caddyfile")).body)
    } catch {
      setError(true)
    }
  }, [apply])

  useEffect(() => {
    api<CaddyfileState>("/api/caddyfile")
      .then(({ body }) => apply(body))
      .catch(() => setError(true))
  }, [apply])

  const dirty = base !== null && text !== base.text

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])

  const deployed = useCallback((deployedText: string, hash: string) => {
    setBase({ text: deployedText, hash })
  }, [])

  return { base, text, setText, dirty, error, load, deployed }
}
