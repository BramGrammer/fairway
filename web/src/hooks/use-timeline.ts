import { useEffect, useSyncExternalStore } from "react"

import { api } from "@/lib/api"
import type { TimelineReply } from "@/lib/timeline"

export const TIMELINE_WINDOW_S = 24 * 3600
const POLL_MS = 60_000

// One request per page, however many strips are mounted: they share this store.
let snapshot: TimelineReply | null = null
let users = 0
let timer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

function load() {
  if (document.visibilityState === "hidden") return
  api<TimelineReply>(`/api/events/timeline?window=${TIMELINE_WINDOW_S}`, undefined, { background: true })
    .then(({ body }) => {
      snapshot = body
      listeners.forEach((listener) => listener())
    })
    .catch(() => {})
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The 24 h state timeline of every host, polled gently while at least one component uses it. */
export function useTimeline(): TimelineReply | null {
  useEffect(() => {
    if (users++ === 0) {
      load()
      timer = setInterval(load, POLL_MS)
    }
    document.addEventListener("visibilitychange", load)
    return () => {
      document.removeEventListener("visibilitychange", load)
      if (--users === 0) clearInterval(timer)
    }
  }, [])
  return useSyncExternalStore(subscribe, () => snapshot)
}
