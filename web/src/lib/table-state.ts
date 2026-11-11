export interface PersistedTableOf<Id extends string> {
  sorting: { id: Id; desc: boolean }[]
  visibility: Partial<Record<Id, boolean>>
}

/**
 * Reads the stored sorting and column visibility of a data table. Only known column ids are kept, one column
 * at most is sorted, and anything unexpected is dropped instead of thrown, so a stale or hand-edited entry is harmless.
 */
export function parsePersistedTable<Id extends string>(
  raw: string | null,
  ids: readonly Id[],
  unsortable: readonly Id[] = [],
): PersistedTableOf<Id> {
  const empty: PersistedTableOf<Id> = { sorting: [], visibility: {} }
  if (!raw) return empty
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return empty
  }
  if (typeof data !== "object" || data === null) return empty
  const isColumn = (id: unknown): id is Id => ids.includes(id as Id)
  const { sorting, visibility } = data as Record<string, unknown>
  const out: PersistedTableOf<Id> = { sorting: [], visibility: {} }
  if (Array.isArray(sorting)) {
    for (const item of sorting) {
      if (typeof item !== "object" || item === null) continue
      const { id, desc } = item as Record<string, unknown>
      if (isColumn(id) && !unsortable.includes(id) && typeof desc === "boolean") out.sorting.push({ id, desc })
    }
    out.sorting = out.sorting.slice(0, 1)
  }
  if (typeof visibility === "object" && visibility !== null && !Array.isArray(visibility)) {
    for (const [id, value] of Object.entries(visibility)) {
      if (isColumn(id) && typeof value === "boolean") out.visibility[id] = value
    }
  }
  return out
}
