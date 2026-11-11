/** Which hosts use which upstream, read from the running config. */

import type { RouteMap } from "./alert-settings.js";
import { summarizeRoutes } from "./routes.js";
import { upstreamKey } from "./watcher.js";

export function buildRouteMap(servers: Record<string, unknown>): RouteMap {
  const sets = new Map<string, Set<string>>();
  for (const site of summarizeRoutes(servers)) {
    for (const rule of site.rules) {
      for (const destination of rule.destinations) {
        for (const upstream of destination.upstreams ?? []) {
          const hosts = sets.get(upstreamKey(upstream)) ?? new Set<string>();
          for (const host of site.hosts) hosts.add(host);
          sets.set(upstreamKey(upstream), hosts);
        }
      }
    }
  }
  return { upstreamHosts: new Map([...sets].map(([upstream, hosts]) => [upstream, [...hosts]])) };
}
