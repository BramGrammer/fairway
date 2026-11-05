import { useEffect, useState } from "react"

/** Follows the `dark` class that ThemeProvider puts on <html>. */
export function useIsDark() {
  const root = document.documentElement
  const [dark, setDark] = useState(() => root.classList.contains("dark"))
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(root.classList.contains("dark"))
    )
    observer.observe(root, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [root])
  return dark
}
