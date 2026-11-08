/** Links the route drawer offers: where a Site, Rule or Destination can be opened, and what Copy puts on the clipboard. */

export interface Link {
  /** What the button shows. */
  label: string
  url: string
  /** What Copy puts on the clipboard: the bare host or upstream address; null when Copy does not apply. */
  copy: string | null
}

interface SiteAddress {
  hosts: string[]
  listen: string[]
}

const portOf = (address: string) => address.slice(address.lastIndexOf(":") + 1)

const unlinkableHost = (host: string) =>
  !host || host.includes("*") || host === "localhost" || host.endsWith(".localhost") || /[{}\s/]/.test(host)

/** Origin for each host: http only when the Site listens on port 80 alone; a non-default port is spelled out. */
function origins(site: SiteAddress): Link[] {
  const ports = site.listen.map(portOf)
  const httpOnly = ports.length > 0 && ports.every((port) => port === "80")
  const scheme = httpOnly ? "http" : "https"
  const port = !httpOnly && ports.length > 0 && !ports.includes("443") && /^\d+$/.test(ports[0]) ? `:${ports[0]}` : ""
  return [...new Set(site.hosts)]
    .filter((host) => !unlinkableHost(host))
    .map((host) => ({ label: host, url: `${scheme}://${host}${port}`, copy: host }))
}

/** One link per host of a Site. */
export const hostLinks = (site: SiteAddress): Link[] => origins(site)

/** Paths a rule match stands for, or null when it is not a plain path. */
function pathsOf(match: string): string[] | null {
  if (match === "") return [""]
  const found = /^path (\/\S*(?: \/\S*)*)$/.exec(match)
  if (!found) return null
  const cleaned: string[] = []
  for (const path of found[1].split(" ")) {
    const stripped = path.endsWith("*") ? path.slice(0, -1) : path
    if (stripped.includes("*")) return null
    cleaned.push(stripped)
  }
  return cleaned
}

/** Host plus path for each host and path of a Rule; regex or compound matches get none. */
export function ruleLinks(site: SiteAddress, match: string): Link[] {
  const paths = pathsOf(match)
  if (!paths) return []
  return origins(site).flatMap((origin) =>
    paths.map((path) => ({ label: `${origin.label}${path}`, url: `${origin.url}${path}`, copy: null })),
  )
}

/** Link for a proxy upstream; the routes summary already prefixes https:// when Caddy talks TLS to it. */
export function upstreamLink(upstream: string): Link | null {
  const secure = upstream.startsWith("https://")
  const address = secure ? upstream.slice("https://".length) : upstream
  if (!address || address === "?" || /[{}\s]|^unix/.test(address)) return null
  return { label: address, url: `${secure ? "https" : "http"}://${address}`, copy: address }
}
