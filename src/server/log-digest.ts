/**
 * A digest of the Access log of one or more Sites over a period (ADR 0009).
 *
 * The digest is what a Review sends to the model in place of the log lines, so it is built to stay small
 * whatever the traffic: fixed top-N lists, per-hour buckets, truncated paths and user agents, and no query
 * strings. It is a plain JSON-serialisable object.
 *
 * The whole period is read as a stream, forward, line by line, across the current file and its rotated
 * files (gzip-compressed ones too, Caddy's `roll_gzip`). Files are read newest first within a total byte
 * limit, so when the limit is reached the oldest part of the period is the part left unseen. The digest
 * says which parts of the period it could not see, per Site, and why.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { bareHost, parseAccessLine, resolveHostLogFile, type AccessLogLine, type HostLogFile } from "./host-logs.js";

export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const HOUR_MS = 3_600_000;
const TOP_N = 15;
const MIN_CLIENT_REQUESTS = 10;
const MAX_PATH_LENGTH = 200;
const MAX_USER_AGENT_LENGTH = 200;
const MAX_METHOD_LENGTH = 24;
/** Bounds on what is tracked while reading, so that hostile traffic cannot grow memory without limit. */
const MAX_TRACKED_CLIENTS = 200_000;
const MAX_TRACKED_VALUES = 100_000;
const MAX_PATHS_PER_CLIENT = 1_000;
const COMMON_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const DENIED = new Set([401, 403, 404]);

export interface DigestSite {
  /** Hosts of the Site, as in the Caddyfile. A leading `*.` matches any subdomain. */
  hosts: string[];
}

export interface LogDigestOptions {
  /** The running config's `logging` section and HTTP servers, which say where each host logs. */
  logging: unknown;
  servers: unknown;
  /** The mounted folder holding Caddy's log files. */
  logDir: string;
  sites: DigestSite[];
  /** The period, epoch milliseconds. */
  from: number;
  to: number;
  /** Most bytes (decompressed) read over all files. Default 256 MiB. */
  maxBytes?: number;
}

export interface Interval {
  from: number;
  to: number;
}

export type UnseenReason =
  /** The period starts before the oldest line Caddy kept, so older lines were rotated away (or never written). */
  | "rotated-away"
  /** Reading stopped at the size limit. */
  | "size-limit"
  /** A file could not be read to its end. */
  | "read-error";

export interface UnseenPart extends Interval {
  reason: UnseenReason;
  /** Base name of the log file the gap is in. */
  file: string;
}

export interface ClientDigest {
  client: string;
  requests: number;
  /** Share of this client's requests answered 4xx, 0 to 1. */
  share4xx: number;
  /** Distinct paths (query strings cut) requested, counted up to 1000. */
  distinctPaths: number;
}

export interface SiteDigest {
  /** The Site's first host. */
  site: string;
  hosts: string[];
  /** The period asked for. */
  period: Interval;
  coverage: {
    /** True when the whole period was seen. */
    complete: boolean;
    /** The parts of the period that were read; with `unseen`, they make up the period. */
    covered: Interval[];
    unseen: UnseenPart[];
    /** Log files read for this Site. */
    files: string[];
  };
  totals: {
    requests: number;
    /** Requests per status code, as strings: `{ "200": 120, "404": 3 }`. */
    byStatus: Record<string, number>;
    /** Lines in the period without a status. */
    noStatus: number;
  };
  /** One entry per hour with requests, oldest first. `hour` is the start of the hour, epoch milliseconds (UTC). */
  perHour: Array<{ hour: number; requests: number; byStatus: Record<string, number> }>;
  /** Busiest clients by request count. */
  topClients: ClientDigest[];
  /** Clients with the largest share of 4xx responses, among those with at least `limits.minClientRequests` requests. */
  topClientsBy4xx: ClientDigest[];
  /** Paths answered 401, 403 or 404, most often first. Query strings are cut. */
  topDeniedPaths: Array<{ path: string; requests: number; byStatus: Record<string, number> }>;
  /** Methods other than GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS. */
  unusualMethods: Array<{ method: string; requests: number }>;
  topUserAgents: Array<{ userAgent: string; requests: number }>;
  /** True when so many distinct clients, paths or user agents were seen that some were not tracked. */
  approximate: boolean;
}

export type SkippedSite = { site: string; hosts: string[]; reason: "not-logged" | "no-file-writer" | "missing-file" | "no-host" };

export interface LogDigest {
  /** The period, epoch milliseconds. */
  period: Interval;
  limits: {
    maxBytes: number;
    topN: number;
    minClientRequests: number;
    maxPathLength: number;
    maxUserAgentLength: number;
  };
  /** Bytes read from the log files, decompressed. */
  bytesRead: number;
  /** Sites with an Access log that could be read. */
  sites: SiteDigest[];
  /** Sites without one, and why. */
  skipped: SkippedSite[];
}

// ---------------------------------------------------------------------------------------------------------

class SiteStats {
  requests = 0;
  noStatus = 0;
  byStatus = new Map<number, number>();
  perHour = new Map<number, { requests: number; byStatus: Map<number, number> }>();
  clients = new Map<string, { requests: number; r4xx: number; paths: Set<string> }>();
  denied = new Map<string, Map<number, number>>();
  methods = new Map<string, number>();
  userAgents = new Map<string, number>();
  approximate = false;
  files = new Set<string>();
  unseen: UnseenPart[] = [];

  add(line: AccessLogLine, time: number): void {
    this.requests++;
    const status = line.status;
    const hour = Math.floor(time / HOUR_MS) * HOUR_MS;
    let bucket = this.perHour.get(hour);
    if (!bucket) this.perHour.set(hour, (bucket = { requests: 0, byStatus: new Map() }));
    bucket.requests++;
    if (status === null) this.noStatus++;
    else {
      bump(this.byStatus, status);
      bump(bucket.byStatus, status);
    }

    const path = cleanPath(line.uri);
    const client = line.client || "unknown";
    let entry = this.clients.get(client);
    if (!entry && this.clients.size < MAX_TRACKED_CLIENTS) this.clients.set(client, (entry = { requests: 0, r4xx: 0, paths: new Set() }));
    if (entry) {
      entry.requests++;
      if (status !== null && status >= 400 && status < 500) entry.r4xx++;
      if (entry.paths.size < MAX_PATHS_PER_CLIENT) entry.paths.add(path);
    } else this.approximate = true;

    if (status !== null && DENIED.has(status)) {
      let byStatus = this.denied.get(path);
      if (!byStatus && this.denied.size < MAX_TRACKED_VALUES) this.denied.set(path, (byStatus = new Map()));
      if (byStatus) bump(byStatus, status);
      else this.approximate = true;
    }

    if (!COMMON_METHODS.has(line.method)) this.countValue(this.methods, truncate(line.method, MAX_METHOD_LENGTH));
    this.countValue(this.userAgents, truncate(line.userAgent, MAX_USER_AGENT_LENGTH));
  }

  private countValue(map: Map<string, number>, key: string): void {
    if (map.has(key) || map.size < MAX_TRACKED_VALUES) bump(map, key);
    else this.approximate = true;
  }
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** The request path: no query string or fragment, and a bounded length. */
function cleanPath(uri: string): string {
  const cut = uri.search(/[?#]/);
  return truncate(cut === -1 ? uri : uri.slice(0, cut), MAX_PATH_LENGTH) || "/";
}

const byCountThenName = <T>(count: (t: T) => number, name: (t: T) => string) => (a: T, b: T) => count(b) - count(a) || name(a).localeCompare(name(b));

function statusRecord(map: Map<number, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v]));
}

/** The complement of `unseen` inside `period`. */
function coveredParts(period: Interval, unseen: Interval[]): Interval[] {
  const sorted = unseen.filter((u) => u.to > u.from).sort((a, b) => a.from - b.from);
  const covered: Interval[] = [];
  let cursor = period.from;
  for (const gap of sorted) {
    if (gap.from > cursor) covered.push({ from: cursor, to: gap.from });
    cursor = Math.max(cursor, gap.to);
  }
  if (cursor < period.to) covered.push({ from: cursor, to: period.to });
  return covered;
}

function clientDigest([client, c]: [string, { requests: number; r4xx: number; paths: Set<string> }]): ClientDigest {
  return { client, requests: c.requests, share4xx: Math.round((c.r4xx / c.requests) * 1000) / 1000, distinctPaths: c.paths.size };
}

function finish(site: DigestSite, stats: SiteStats, period: Interval): SiteDigest {
  const clients = [...stats.clients.entries()];
  const unseen = stats.unseen.filter((u) => u.to > u.from).sort((a, b) => a.from - b.from);
  return {
    site: site.hosts[0],
    hosts: site.hosts,
    period,
    coverage: { complete: unseen.length === 0, covered: coveredParts(period, unseen), unseen, files: [...stats.files].sort() },
    totals: { requests: stats.requests, byStatus: statusRecord(stats.byStatus), noStatus: stats.noStatus },
    perHour: [...stats.perHour.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([hour, bucket]) => ({ hour, requests: bucket.requests, byStatus: statusRecord(bucket.byStatus) })),
    topClients: clients.sort(byCountThenName((c) => c[1].requests, (c) => c[0])).slice(0, TOP_N).map(clientDigest),
    topClientsBy4xx: clients
      .filter(([, c]) => c.requests >= MIN_CLIENT_REQUESTS && c.r4xx > 0)
      .sort((a, b) => b[1].r4xx / b[1].requests - a[1].r4xx / a[1].requests || b[1].requests - a[1].requests || a[0].localeCompare(b[0]))
      .slice(0, TOP_N)
      .map(clientDigest),
    topDeniedPaths: [...stats.denied.entries()]
      .map(([path, byStatus]) => ({ path, requests: [...byStatus.values()].reduce((a, b) => a + b, 0), byStatus: statusRecord(byStatus) }))
      .sort(byCountThenName((p) => p.requests, (p) => p.path))
      .slice(0, TOP_N),
    unusualMethods: [...stats.methods.entries()]
      .map(([method, requests]) => ({ method, requests }))
      .sort(byCountThenName((m) => m.requests, (m) => m.method))
      .slice(0, TOP_N),
    topUserAgents: [...stats.userAgents.entries()]
      .map(([userAgent, requests]) => ({ userAgent, requests }))
      .sort(byCountThenName((u) => u.requests, (u) => u.userAgent))
      .slice(0, TOP_N),
    approximate: stats.approximate,
  };
}

// ---------------------------------------------------------------------------------------------------------

/** Finds the Site a request host belongs to: an exact host first, then the longest `*.` wildcard. */
class HostIndex {
  private readonly exact = new Map<string, number>();
  private readonly wildcards: Array<{ suffix: string; site: number }> = [];

  add(host: string, site: number): void {
    const bare = bareHost(host);
    if (bare.startsWith("*.")) this.wildcards.push({ suffix: bare.slice(1), site });
    else if (!this.exact.has(bare)) this.exact.set(bare, site);
  }

  find(host: string): number | undefined {
    const bare = bareHost(host);
    const exact = this.exact.get(bare);
    if (exact !== undefined) return exact;
    let best: { suffix: string; site: number } | undefined;
    for (const w of this.wildcards) if (bare.endsWith(w.suffix) && (!best || w.suffix.length > best.suffix.length)) best = w;
    return best?.site;
  }
}

interface FileChain {
  /** Current file first, then rotated files, newest first. */
  paths: string[];
  index: HostIndex;
  /** The sites whose hosts log to this chain. */
  sites: Set<number>;
}

interface ReadFile {
  path: string;
  /** Time range of every line seen in the file, whichever host. */
  first: number | null;
  last: number | null;
  partial: UnseenReason | null;
  /** This is the oldest file of the chain, so nothing older exists. */
  oldestOfChain: boolean;
}

/**
 * Streams one file forward, handing lines in the period to `onLine`. Stops at the byte allowance (`partial`)
 * and when the lines are past the end of the period. Returns the bytes read.
 */
async function streamFile(path: string, allowance: number, period: Interval, onLine: (line: AccessLogLine, time: number) => void): Promise<{ file: Omit<ReadFile, "path" | "oldestOfChain">; bytes: number }> {
  const file: Omit<ReadFile, "path" | "oldestOfChain"> = { first: null, last: null, partial: null };
  let bytes = 0;
  const raw = createReadStream(path);
  const input = path.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  const failed = new Promise<never>((_, reject) => {
    raw.on("error", reject);
    input.on("error", reject);
  });
  failed.catch(() => {}); // a rejection is read in the loop below, through the stream ending
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    const iterate = async () => {
      for await (const text of rl) {
        const size = Buffer.byteLength(text) + 1;
        if (bytes + size > allowance) {
          file.partial = "size-limit";
          return;
        }
        bytes += size;
        const line = parseAccessLine(text);
        if (!line || line.time === null) continue;
        file.first = file.first === null ? line.time : Math.min(file.first, line.time);
        file.last = file.last === null ? line.time : Math.max(file.last, line.time);
        if (line.time > period.to) return; // written in time order: the rest is later still
        if (line.time >= period.from) onLine(line, line.time);
      }
    };
    await Promise.race([iterate(), failed]);
  } catch {
    file.partial = "read-error";
  } finally {
    rl.close();
    raw.destroy();
    input.destroy();
  }
  return { file, bytes };
}

async function fileInfo(path: string): Promise<{ mtime: number } | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? { mtime: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

export async function buildLogDigest(options: LogDigestOptions): Promise<LogDigest> {
  const { logging, servers, logDir, sites } = options;
  const period = { from: options.from, to: options.to };
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const skipped: SkippedSite[] = [];

  // Group the Sites' hosts by the file they log to, so that a shared file is read once.
  const chains = new Map<string, FileChain>();
  const readable = new Set<number>();
  for (const [i, site] of sites.entries()) {
    let failure: SkippedSite["reason"] | null = null;
    for (const host of site.hosts) {
      if (bareHost(host) === "*") continue;
      const resolved: HostLogFile = await resolveHostLogFile({ logging, servers, logDir, host, compressed: true });
      if (!resolved.ok) {
        failure ??= resolved.reason;
        continue;
      }
      let chain = chains.get(resolved.path);
      if (!chain) chains.set(resolved.path, (chain = { paths: [resolved.path, ...resolved.rotated], index: new HostIndex(), sites: new Set() }));
      chain.index.add(host, i);
      chain.sites.add(i);
      readable.add(i);
    }
    if (!readable.has(i)) skipped.push({ site: site.hosts[0] ?? "", hosts: site.hosts, reason: failure ?? "no-host" });
  }

  const stats = new Map<number, SiteStats>([...readable].map((i) => [i, new SiteStats()]));
  let remaining = maxBytes;
  let bytesRead = 0;

  for (const [currentPath, chain] of chains) {
    const name = basename(currentPath);
    // Newest first: when the size limit is reached, the oldest part of the period is what stays unseen.
    const read: ReadFile[] = [];
    let skippedBySize = false;
    for (const [n, path] of chain.paths.entries()) {
      const info = await fileInfo(path);
      if (!info) continue; // rotated or removed while we read
      // A rotated file was last written when it was rotated: older than the period means nothing of it matters.
      if (n > 0 && info.mtime < period.from) break;
      if (remaining <= 0) {
        skippedBySize = true;
        break;
      }
      const { file, bytes } = await streamFile(path, remaining, period, (line, time) => {
        const site = chain.index.find(line.host);
        if (site !== undefined) stats.get(site)?.add(line, time);
      });
      remaining -= bytes;
      bytesRead += bytes;
      read.push({ path, ...file, oldestOfChain: n === chain.paths.length - 1 });
      if (file.partial === "size-limit") {
        remaining = 0;
        skippedBySize = n < chain.paths.length - 1;
        break;
      }
    }
    read.reverse(); // oldest first

    const gaps: UnseenPart[] = [];
    const gap = (from: number, to: number, reason: UnseenReason) => {
      const part = { from: Math.max(from, period.from), to: Math.min(to, period.to), reason, file: name };
      if (part.to > part.from) gaps.push(part);
    };
    const first = read[0];
    if (!first) gap(period.from, period.to, skippedBySize ? "size-limit" : "rotated-away");
    else {
      if (skippedBySize) gap(period.from, first.first ?? period.to, "size-limit");
      else if (first.oldestOfChain && first.first !== null && first.first > period.from) gap(period.from, first.first, "rotated-away");
      for (const [n, file] of read.entries()) {
        if (file.partial) gap(file.last ?? period.from, read[n + 1]?.first ?? period.to, file.partial);
      }
    }
    for (const i of chain.sites) {
      const s = stats.get(i);
      if (!s) continue;
      s.files.add(name);
      s.unseen.push(...gaps);
    }
  }

  return {
    period,
    limits: { maxBytes, topN: TOP_N, minClientRequests: MIN_CLIENT_REQUESTS, maxPathLength: MAX_PATH_LENGTH, maxUserAgentLength: MAX_USER_AGENT_LENGTH },
    bytesRead,
    sites: [...stats.entries()].sort((a, b) => a[0] - b[0]).map(([i, s]) => finish(sites[i], s, period)),
    skipped,
  };
}
