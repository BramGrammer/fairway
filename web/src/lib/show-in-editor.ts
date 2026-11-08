const EVENT = "fairway:show-in-editor"

/** Asks the app to switch to the editor and select the Site that answers for `host`. */
export function requestShowInEditor(host: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: host }))
}

/** Listens for requests from `requestShowInEditor`; returns the unsubscribe function. */
export function onShowInEditor(listener: (host: string) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<string>).detail)
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}

/** The drawer is titled with a label; the catch-all Site is shown as "any host". */
export function hostFromLabel(label: string): string {
  return label === "any host" ? "*" : label
}
