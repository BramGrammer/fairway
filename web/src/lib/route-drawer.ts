export type NodeKind = "host" | "rule" | "destination" | "group"

export const MIN_DRAWER_WIDTH = 380
export const DEFAULT_DRAWER_WIDTH = 520
export const DRAWER_STORAGE_KEY = "fairway:route-drawer-width"

/** The kind of a graph node, read from its id. */
export function nodeKind(id: string): NodeKind {
  if (id.startsWith("host-group:") || id.startsWith("dest-group:")) return "group"
  if (id.startsWith("host:")) return "host"
  if (id.startsWith("handler:") || id.startsWith("mw:")) return "rule"
  return "destination"
}

/** Keeps the drawer wide enough to use and narrow enough to leave the graph visible. */
export function clampDrawerWidth(width: number, available: number): number {
  return Math.max(MIN_DRAWER_WIDTH, Math.min(width, Math.floor(available * 0.7)))
}

export function parseStoredWidth(raw: string | null): number {
  const value = Number(raw)
  return raw !== null && Number.isFinite(value) && value > 0 ? value : DEFAULT_DRAWER_WIDTH
}
