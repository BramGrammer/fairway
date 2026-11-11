/**
 * Fairway's own rules: known foot-guns, as warning Findings. A pure function from the adapted JSON
 * (what Caddy's /adapt returns as `result`, so snippets and imports are already resolved) and the
 * Caddyfile text. A Finding about a Site sits on that Site's block when the host lookup finds it.
 */

import type { Finding } from "./findings.js";
import { resolveLogger } from "./host-logs.js";
import { siteLine } from "./site-blocks.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const NS_PER_SECOND = 1e9;
/** Caddy's defaults for an active health check. */
const DEFAULT_INTERVAL = 30 * NS_PER_SECOND;
const DEFAULT_TIMEOUT = 5 * NS_PER_SECOND;

interface ProxySite {
  hosts: string[];
  /** Health check settings of one reverse_proxy handler, when it has an active check. */
  checks: { upstreams: string[]; interval: number; timeout: number }[];
}

/** Nanoseconds from a Caddy duration: a number (nanoseconds) or a string such as "250ms" or "1m30s". */
export function durationNs(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  const units: Record<string, number> = { ns: 1, us: 1e3, "µs": 1e3, ms: 1e6, s: 1e9, m: 6e10, h: 3.6e12, d: 8.64e13 };
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h|d)/g;
  let total = 0;
  let consumed = 0;
  for (const m of value.trim().matchAll(re)) {
    total += Number(m[1]) * units[m[2]!]!;
    consumed += m[0].length;
  }
  return consumed === value.trim().length && consumed > 0 ? total : undefined;
}

function* handlers(routes: unknown): Generator<Obj> {
  for (const route of list(routes)) {
    if (!isObj(route)) continue;
    for (const handler of list(route.handle)) {
      if (!isObj(handler)) continue;
      yield handler;
      if (handler.handler === "subroute") yield* handlers(handler.routes);
    }
  }
}

function hostsOf(route: Obj): string[] {
  const hosts: string[] = [];
  for (const set of list(route.match)) {
    if (!isObj(set)) continue;
    for (const h of list(set.host)) if (typeof h === "string") hosts.push(h);
  }
  return hosts;
}

/** The top-level routes of every HTTP server, with the hosts they answer for. */
function sites(config: Obj): ProxySite[] {
  const apps = isObj(config.apps) ? config.apps : {};
  const http = isObj(apps.http) ? apps.http : {};
  const servers = isObj(http.servers) ? Object.values(http.servers) : [];
  const out: ProxySite[] = [];
  for (const server of servers) {
    if (!isObj(server)) continue;
    for (const route of list(server.routes)) {
      if (!isObj(route)) continue;
      const hosts = hostsOf(route);
      const checks: ProxySite["checks"] = [];
      for (const handler of handlers([route])) {
        if (handler.handler !== "reverse_proxy") continue;
        const active = isObj(handler.health_checks) && isObj(handler.health_checks.active) ? handler.health_checks.active : null;
        if (!active) continue;
        checks.push({
          upstreams: list(handler.upstreams).flatMap((u) => (isObj(u) && typeof u.dial === "string" ? [u.dial] : [])),
          interval: durationNs(active.interval) ?? DEFAULT_INTERVAL,
          timeout: durationNs(active.timeout) ?? DEFAULT_TIMEOUT,
        });
      }
      if (hosts.length > 0 || checks.length > 0) out.push({ hosts, checks });
    }
  }
  return out;
}

const warning = (message: string, line?: number): Finding => ({ level: "warning", message, origin: "rules", ...(line !== undefined && { line }) });

export function runRules(config: unknown, text: string): Finding[] {
  const root = isObj(config) ? config : {};
  const apps = isObj(root.apps) ? root.apps : {};
  const http = isObj(apps.http) ? apps.http : {};
  const servers = isObj(http.servers) ? http.servers : {};
  const found = sites(root);
  const findings: Finding[] = [];

  // 1. A Site with no access log: its Logs tab has nothing to read.
  const seen = new Set<string>();
  for (const site of found) {
    for (const host of site.hosts) {
      if (seen.has(host.toLowerCase())) continue;
      seen.add(host.toLowerCase());
      if (resolveLogger(servers, host) !== null) continue;
      findings.push(warning(`${host} has no access log, so its Logs tab will stay empty. Add a log directive to its block to fill it.`, siteLine(text, host)));
    }
  }

  // 2. Health checks that flood the log or flap.
  for (const site of found) {
    const host = site.hosts[0];
    for (const check of site.checks) {
      const tooShort = check.interval < NS_PER_SECOND;
      const slow = check.timeout >= check.interval;
      if (!tooShort && !slow) continue;
      const subject = [host, check.upstreams.join(", ")].filter(Boolean).join(" -> ") || "A reverse_proxy";
      const reason = [
        slow ? "its timeout is not shorter than its interval" : "",
        tooShort ? "its interval is under one second" : "",
      ].filter(Boolean).join(" and ");
      findings.push(warning(`The health check for ${subject} may flood the log or make the upstream flap: ${reason}.`, host ? siteLine(text, host) : undefined));
    }
  }

  // 3. Metrics off: Traffic has nothing to chart. Only worth saying when there is something to serve.
  if (found.some((s) => s.hosts.length > 0) && !isObj(http.metrics)) {
    findings.push(warning("Metrics are not enabled, so Traffic will stay empty. Add `metrics` to the global options block."));
  }

  // 4. Admin endpoint on TCP: after a Reload Fairway may no longer reach it.
  const admin = isObj(root.admin) ? root.admin : {};
  if (typeof admin.listen === "string" && admin.listen !== "" && !/^(unix\/|unixgram\/|\/)/.test(admin.listen) && admin.disabled !== true) {
    findings.push(
      warning(
        `The admin endpoint listens on ${admin.listen} instead of the socket. After the Reload Fairway may lose its connection to Caddy. Remove the admin option from the global block, or point it at the socket Fairway uses.`,
      ),
    );
  }

  return findings;
}
