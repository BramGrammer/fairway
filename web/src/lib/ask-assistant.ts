const EVENT = "fairway:ask-assistant"

/** Asks the app to open the Assistant on a new Conversation that starts with this message. */
export function requestAssistant(message: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: message }))
}

/** Listens for requests from `requestAssistant`; returns the unsubscribe function. */
export function onAskAssistant(listener: (message: string) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<string>).detail)
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}
