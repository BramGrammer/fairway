import { useSyncExternalStore, type ReactNode } from "react"

import { RouterContext, type RouterApi } from "@/hooks/use-router"
import { buildUrl, isPlainClick, patchParams, resolveLocation, type Page, type Params } from "@/lib/router"

const CHANGED = "fairway:location"
/** Marks a history entry that opened a panel, so closing it can go back instead of stacking another entry. */
const PANEL = "fairway-panel"

const current = () => resolveLocation(window.location)
const href = () => window.location.pathname + window.location.search + window.location.hash

/** Replaces a non canonical URL (unknown path, legacy hash). Safe to run more than once. */
function normalize() {
  const { redirect } = current()
  if (redirect !== null) window.history.replaceState(window.history.state, "", redirect)
}

function subscribe(onChange: () => void) {
  const onPop = () => {
    normalize()
    onChange()
  }
  window.addEventListener("popstate", onPop)
  window.addEventListener(CHANGED, onChange)
  return () => {
    window.removeEventListener("popstate", onPop)
    window.removeEventListener(CHANGED, onChange)
  }
}

function write(mode: "push" | "replace", url: string, panel: boolean) {
  if (mode === "push" && url === href()) return
  const state = panel ? { [PANEL]: true } : mode === "replace" ? window.history.state : null
  if (mode === "push") window.history.pushState(state, "", url)
  else window.history.replaceState(state, "", url)
  window.dispatchEvent(new Event(CHANGED))
}

export function RouterProvider({ children }: { children: ReactNode }) {
  // The first snapshot is read before anything renders, so a legacy or unknown URL is fixed first.
  useSyncExternalStore(subscribe, () => (normalize(), href()))
  const { page, params } = current()

  const navigate = (to: Page, next: Params = {}) => write("push", buildUrl(to, next), false)
  const openPanel: RouterApi["openPanel"] = (patch) => {
    const now = current()
    write("push", buildUrl(now.page, patchParams(now.params, patch)), true)
  }
  const replaceParams: RouterApi["replaceParams"] = (patch) => {
    const now = current()
    write("replace", buildUrl(now.page, patchParams(now.params, patch)), false)
  }
  const closePanel: RouterApi["closePanel"] = (keys) => {
    const now = current()
    if (!keys.some((key) => now.params[key] !== undefined)) return
    if (window.history.state?.[PANEL]) {
      window.history.back()
      return
    }
    write("replace", buildUrl(now.page, patchParams(now.params, Object.fromEntries(keys.map((key) => [key, undefined])))), false)
  }
  const linkProps: RouterApi["linkProps"] = (to, next = {}) => ({
      href: buildUrl(to, next),
      onClick: (event) => {
        if (!isPlainClick(event.nativeEvent)) return
        event.preventDefault()
        navigate(to, next)
      },
  })

  const value: RouterApi = { page, params, navigate, openPanel, replaceParams, closePanel, linkProps }
  return <RouterContext value={value}>{children}</RouterContext>
}
