import { useEffect, useRef, useState } from "react"

/** Copies text to the clipboard; `copied` stays true for a moment afterwards so a button can say so. */
export function useCopy(resetMs = 1500) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), resetMs)
    } catch {
      // Clipboard access can be refused; there is nothing useful to show.
    }
  }

  return { copied, copy }
}
