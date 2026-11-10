/**
 * The rows to show and how many arrived but are held back. Rows arrive oldest first; those after
 * `heldAfter` (a row id) are held back, and `null` holds nothing back. This is the one place the displayed
 * list is derived from what has arrived.
 */
export function visibleRows<T extends { id: number }>(rows: T[], heldAfter: number | null): { shown: T[]; held: number } {
  if (heldAfter === null) return { shown: rows, held: 0 }
  const shown = rows.filter((row) => row.id <= heldAfter)
  return { shown, held: rows.length - shown.length }
}

/** The list as displayed: the newest row first. */
export function newestFirst<T>(rows: T[]): T[] {
  return rows.toReversed()
}
