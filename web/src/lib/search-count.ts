import type { EditorState } from "@codemirror/state"
import type { SearchQuery } from "@codemirror/search"

/** Counting stops here so a one-letter search in a big file stays cheap. */
export const COUNT_LIMIT = 1000

export interface MatchCount {
  total: number
  /** 1-based position of the match that is selected, or null when the selection is not on a match. */
  current: number | null
  /** There are more matches than were counted. */
  capped: boolean
}

/** How many matches a search has in the document, and which one is selected. */
export function countMatches(state: EditorState, query: SearchQuery): MatchCount {
  if (!query.valid) return { total: 0, current: null, capped: false }
  const { from, to } = state.selection.main
  const cursor = query.getCursor(state)
  let total = 0
  let current: number | null = null
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    total++
    if (step.value.from === from && step.value.to === to) current = total
    if (total >= COUNT_LIMIT) return { total, current, capped: true }
  }
  return { total, current, capped: false }
}

/** The text next to the search field: nothing for an empty search, otherwise how many there are. */
export function describeCount(search: string, valid: boolean, count: MatchCount): string {
  if (search === "") return ""
  if (!valid) return "Invalid search"
  if (count.total === 0) return "No results"
  const total = `${count.total}${count.capped ? "+" : ""}`
  return count.current === null ? `${total} found` : `${count.current} of ${total}`
}
