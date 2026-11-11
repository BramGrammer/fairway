/**
 * The access log lines of one host, found through the running Caddy config.
 *
 * Resolution: the HTTP servers' `logs.logger_names` map a host to a logger name (a host on a custom
 * port may be keyed with or without the port, so we match by bare name); a host without an entry uses
 * `logs.default_logger_name`, or the default logger. The top-level `logging.logs.<name>` gives that
 * logger's writer. Only `writer.output: "file"` can be read; the file is mapped into `logDir` by name.
 * Lines are filtered on the request host Caddy recorded, which never has a port.
 */

import { readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { scanLinesBackward } from "./logs.js";

export interface AccessLogLine {
  /** Epoch milliseconds, or null when the line has no usable timestamp. */
  time: number | null;
  status: number | null;
  method: string;
  host: string;
  /** The request URI as Caddy logged it (path and query, after any redaction). */
  uri: string;
  /** The real visitor when Caddy knows it (`client_ip`), otherwise the connection's address. */
  client: string;
  /** Seconds. */
  duration: number | null;
  /** Response size in bytes. */
  size: number | null;
  userAgent: string;
  /** The whole parsed line, for the expanded view. */
  raw: Record<string, unknown>;
}

export type HostLogResult =
  | { ok: true; /** Base name of the file the lines come from. */ file: string; lines: AccessLogLine[] }
  | { ok: false; reason: "no-file-writer"; output: string }
  /** `file` is the expected base name; `configuredPath` is where Caddy writes it, which may be outside the mounted folder. */
  | { ok: false; reason: "missing-file"; file: string; configuredPath: string }
  | { ok: false; reason: "not-logged" };

export interface HostLogOptions {
  /** The running config's `logging` section (`/config/logging`). */
  logging: unknown;
  /** The running config's HTTP servers (`/config/apps/http/servers`). */
  servers: unknown;
  /** The mounted folder holding Caddy's log files. */
  logDir: string;
  host: string;
  limit: number;
  /** Most bytes read from the end of any one file. Default 8 MiB. */
  maxBytesPerFile?: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** "Example.com:8443" becomes "example.com". Bracketed IPv6 keeps its brackets. */
export function bareHost(host: string): string {
  const h = host.trim().toLowerCase();
  const bracket = /^(\[[^\]]+\])(?::\d+)?$/.exec(h);
  if (bracket) return bracket[1];
  return /^[^:]*:\d+$/.test(h) ? h.slice(0, h.lastIndexOf(":")) : h;
}

/** The logger a host's requests are written to, or null when they are not logged at all. */
export function resolveLogger(servers: unknown, host: string): string | null {
  const want = bareHost(host);
  let fallback: string | null = null;
  let skipped = false;
  for (const server of Object.values(isObj(servers) ? servers : {})) {
    if (!isObj(server) || !isObj(server.logs)) continue; // no `logs` object: this server logs nothing
    const logs = server.logs;
    let mapped: string | undefined;
    for (const [key, names] of Object.entries(isObj(logs.logger_names) ? logs.logger_names : {})) {
      if (bareHost(key) !== want) continue;
      mapped = strings(names)[0] ?? ""; // "" means the default logger
      break;
    }
    if (mapped !== undefined) return mapped || "default";
    // skip_hosts entries carry the port; a mapped host is logged even when listed there.
    if (strings(logs.skip_hosts).some((h) => bareHost(h) === want)) {
      skipped = true;
      continue;
    }
    if (fallback === null && logs.skip_unmapped_hosts !== true) {
      fallback = typeof logs.default_logger_name === "string" && logs.default_logger_name ? logs.default_logger_name : "default";
    }
  }
  return skipped ? null : fallback;
}

/** Whether the logger takes access log records, going by its `include` and `exclude` lists. */
function acceptsAccess(logger: Obj | undefined, name: string): boolean {
  if (!logger) return true;
  const namespace = name === "default" ? "http.log.access" : `http.log.access.${name}`;
  const covers = (prefix: string) => namespace === prefix || namespace.startsWith(`${prefix}.`);
  const include = strings(logger.include);
  const exclude = strings(logger.exclude);
  if (exclude.some(covers)) return false;
  // The default logger takes every namespace unless `include` narrows it.
  if (include.length > 0 && !include.some(covers)) return false;
  return true;
}

function parseLine(text: string): AccessLogLine | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(value) || !isObj(value.request)) return null;
  const request = value.request;
  const host = typeof request.host === "string" ? request.host : "";
  const remoteAddr = typeof request.remote_addr === "string" ? bareHost(request.remote_addr).replace(/^\[|\]$/g, "") : "";
  const client = [request.client_ip, request.remote_ip, remoteAddr].find((v) => typeof v === "string" && v) as string | undefined;
  const headers = isObj(request.headers) ? request.headers : {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const ts = num(value.ts);
  return {
    time: ts === null ? null : Math.round(ts * 1000),
    status: num(value.status),
    method: typeof request.method === "string" ? request.method : "",
    host,
    uri: typeof request.uri === "string" ? request.uri : "",
    client: client ?? "",
    duration: num(value.duration),
    size: num(value.size),
    userAgent: strings(headers["User-Agent"])[0] ?? "",
    raw: value,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rotated siblings of `file` in `dir`, newest first. Names are `<stem>-<timestamp><ext>`, as Caddy writes them. */
async function rotatedSiblings(dir: string, file: string): Promise<string[]> {
  const ext = extname(file);
  const stem = basename(file, ext);
  const pattern = new RegExp(`^${escapeRegExp(stem)}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}(?:\\.\\d+)?${escapeRegExp(ext)}$`);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names.filter((n) => pattern.test(n)).sort().reverse();
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Where a host's lines are written, or why they cannot be read. */
export type HostLogFile =
  | { ok: true; /** Base name of the file. */ file: string; /** Full path inside `logDir`. */ path: string; /** Rotated siblings, newest first. */ rotated: string[] }
  | Exclude<HostLogResult, { ok: true }>;

export type HostLogResolveOptions = Pick<HostLogOptions, "logging" | "servers" | "logDir" | "host">;

/** Resolves the file a host logs to from the running config. Reads the folder, nothing is cached. */
export async function resolveHostLogFile(options: HostLogResolveOptions): Promise<HostLogFile> {
  const { logging, servers, logDir, host } = options;
  const name = resolveLogger(servers, host);
  if (name === null) return { ok: false, reason: "not-logged" };

  const logs = isObj(logging) && isObj(logging.logs) ? logging.logs : {};
  const logger = isObj(logs[name]) ? (logs[name] as Obj) : undefined;
  if (!acceptsAccess(logger, name)) return { ok: false, reason: "not-logged" };

  // Caddy's default writer is stderr.
  const writer = logger && isObj(logger.writer) ? logger.writer : { output: "stderr" };
  const output = typeof writer.output === "string" ? writer.output : "stderr";
  const configuredPath = typeof writer.filename === "string" ? writer.filename : "";
  if (output !== "file" || !configuredPath) return { ok: false, reason: "no-file-writer", output };

  const file = basename(configuredPath);
  const current = join(logDir, file);
  const rotated = await rotatedSiblings(logDir, file);
  if (!(await exists(current)) && rotated.length === 0) {
    return { ok: false, reason: "missing-file", file, configuredPath };
  }
  return { ok: true, file, path: current, rotated: rotated.map((n) => join(logDir, n)) };
}

/** A stable string for a resolution; it changes when the host moves to another file or stops being readable. */
export function resolutionKey(resolved: HostLogFile): string {
  return resolved.ok ? `file:${resolved.path}` : `fail:${resolved.reason}`;
}

/** Parses raw log lines and keeps those recorded for `host` (compared without a port), oldest first. */
export function parseHostLines(lines: string[], host: string): AccessLogLine[] {
  const wanted = bareHost(host);
  const out: AccessLogLine[] = [];
  for (const text of lines) {
    const line = parseLine(text);
    if (line && bareHost(line.host) === wanted) out.push(line);
  }
  return out;
}

export async function readHostLog(options: HostLogOptions): Promise<HostLogResult> {
  const { host, limit } = options;
  const resolved = await resolveHostLogFile(options);
  if (!resolved.ok) return resolved;
  const { file, path: current } = resolved;

  const found: AccessLogLine[] = []; // newest first
  for (const candidate of [current, ...resolved.rotated]) {
    if (found.length >= limit) break;
    await scanLinesBackward(
      candidate,
      (text) => {
        found.push(...parseHostLines([text], host));
        return found.length >= limit;
      },
      options.maxBytesPerFile,
    );
  }
  return { ok: true, file, lines: found.reverse() };
}
