export interface UpstreamStatus {
  fails: number;
  requests: number;
}

/** Caddy's `/reverse_proxy/upstreams` reply as a map from upstream address to its counters. */
export function parseUpstreams(body: string): Record<string, UpstreamStatus> {
  const parsed: unknown = JSON.parse(body);
  if (parsed === null) return {};
  if (!Array.isArray(parsed)) throw new Error("Unexpected upstreams reply from Caddy");
  const result: Record<string, UpstreamStatus> = {};
  for (const entry of parsed as Record<string, unknown>[]) {
    if (typeof entry?.address !== "string") continue;
    result[entry.address] = {
      fails: typeof entry.fails === "number" ? entry.fails : 0,
      requests: typeof entry.num_requests === "number" ? entry.num_requests : 0,
    };
  }
  return result;
}
