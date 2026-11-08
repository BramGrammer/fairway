/** How each host is secured, read from Caddy's configuration (not from probing it). */

export type TlsState =
  | "managed"
  | "on-demand"
  | "internal"
  | "manual"
  | "http-only"
  | "off"
  | "wildcard-covered"
  | "none"

export type TlsConfigReply =
  | { ok: true; sites: { hosts: { host: string; state: TlsState }[] }[] }
  | { ok: false; error: string }

export type TlsStates = Map<string, TlsState>

export function statesFrom(reply: TlsConfigReply | null): TlsStates {
  const states: TlsStates = new Map()
  if (reply?.ok) for (const site of reply.sites) for (const { host, state } of site.hosts) states.set(host, state)
  return states
}

export interface Security {
  /** Served over HTTPS, or only over plain HTTP. */
  kind: "https" | "http"
  label: string
}

const HTTPS: Partial<Record<TlsState, string>> = {
  managed: "HTTPS · Certificate managed by Caddy",
  "on-demand": "HTTPS · Certificate obtained on the first request",
  internal: "HTTPS · signed by Caddy's own CA, so browsers do not trust it by default",
  manual: "HTTPS · Certificate supplied manually",
  "wildcard-covered": "HTTPS · covered by a wildcard Certificate",
}

/** What a Site's primary host says about security; null when Caddy has nothing to say about it. */
export function securityOf(hosts: string[], states: TlsStates): Security | null {
  const state = hosts.map((host) => states.get(host)).find((s): s is TlsState => s !== undefined)
  if (!state) return null
  if (state === "http-only") return { kind: "http", label: "HTTP only · no Certificate" }
  const label = HTTPS[state]
  return label ? { kind: "https", label } : null
}
