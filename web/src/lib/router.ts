/** A small router: which page a URL shows, and the panels and view state kept in its query string. No React or DOM here. */

export const PAGES = ["editor", "routes", "history", "events", "logs"] as const
export type Page = (typeof PAGES)[number]

export const DEFAULT_PAGE: Page = "editor"
export const SETTINGS_CATEGORIES = ["general", "monitoring", "alerts", "access"] as const
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number]

export interface Params {
  /** Settings dialog open on this category (any page). */
  settings?: SettingsCategory
  /** Routes page: how routes are grouped. The graph is the default and is left out. */
  group?: "table"
  /** Routes page: show the editor's unsaved text. The running config is the default and is left out. */
  source?: "editor"
  /** Routes page: the search text. */
  q?: string
  /** Routes page: the node whose details drawer is open (a graph node id). */
  node?: string
  /** History page: the selected revision, a number or "original". */
  revision?: string
}

export interface Resolved {
  page: Page
  params: Params
  /** Where to replace the URL with when it is not canonical (unknown path, legacy hash), else null. */
  redirect: string | null
}

export interface LocationParts {
  pathname: string
  search: string
  hash: string
}

const MAX_TEXT = 200
const MAX_NODE = 500

const isPage = (value: string): value is Page => (PAGES as readonly string[]).includes(value)

/** Parameters each page owns. Settings belongs to every page. */
const OWNED: Record<Page, (keyof Params)[]> = {
  editor: ["settings"],
  routes: ["settings", "group", "source", "q", "node"],
  history: ["settings", "revision"],
  events: ["settings"],
  logs: ["settings"],
}

/** Reads the known parameters of a query string; values that do not validate are dropped. */
export function parseParams(search: string, page: Page): Params {
  const query = new URLSearchParams(search)
  const out: Params = {}
  const owns = (key: keyof Params) => OWNED[page].includes(key)

  const settings = query.get("settings")
  if (owns("settings") && (SETTINGS_CATEGORIES as readonly string[]).includes(settings ?? "")) {
    out.settings = settings as SettingsCategory
  }
  const group = query.get("group")
  if (owns("group") && group === "table") out.group = group
  if (owns("source") && query.get("source") === "editor") out.source = "editor"
  const q = query.get("q")
  if (owns("q") && q && q.length <= MAX_TEXT) out.q = q
  const node = query.get("node")
  if (owns("node") && node && node.length <= MAX_NODE) out.node = node
  const revision = query.get("revision")
  if (owns("revision") && revision && (revision === "original" || /^\d{1,9}$/.test(revision))) out.revision = revision
  return out
}

const ORDER: (keyof Params)[] = ["settings", "group", "source", "q", "node", "revision"]

/** The URL of a page with its parameters. Parameters the page does not own are left out. */
export function buildUrl(page: Page, params: Params = {}): string {
  const query = new URLSearchParams()
  for (const key of ORDER) {
    const value = params[key]
    if (value && OWNED[page].includes(key)) query.set(key, value)
  }
  const text = query.toString()
  return `/${page}${text ? `?${text}` : ""}`
}

/** Merges a patch into params; an undefined value removes that parameter. */
export function patchParams(params: Params, patch: { [K in keyof Params]?: Params[K] | undefined }): Params {
  const next: Record<string, string> = { ...params }
  for (const key of Object.keys(patch) as (keyof Params)[]) {
    const value = patch[key]
    if (value === undefined || value === "") delete next[key]
    else next[key] = value
  }
  return next as Params
}

/** Which page and parameters a location shows, and whether the URL should be replaced by a canonical one. */
export function resolveLocation({ pathname, search, hash }: LocationParts): Resolved {
  const segment = pathname.replace(/^\/+|\/+$/g, "")
  if (isPage(segment)) {
    return { page: segment, params: parseParams(search, segment), redirect: null }
  }
  // Old links used the hash: "/#routes".
  const legacy = hash.replace(/^#/, "")
  const page = segment === "" && isPage(legacy) ? legacy : DEFAULT_PAGE
  const params = parseParams(search, page)
  // Unknown path or legacy hash: keep the query as it came (it may carry parameters of the page we redirect to).
  return { page, params, redirect: `/${page}${search}` }
}

/** Whether a click on a link should be handled by the router (plain left click, no modifier, same tab). */
export function isPlainClick(event: {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented: boolean
}): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

/** The window title of a page. */
export function pageTitle(page: Page): string {
  return `${page[0].toUpperCase()}${page.slice(1)} · Fairway`
}
