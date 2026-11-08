/**
 * The last Certificate issuance error for a host, read from Caddy's runtime log lines.
 *
 * Caddy writes certificate obtain and renew lines through its logger (names starting `tls.`, such as
 * `tls.obtain`, `tls.renew`, `tls.issuance.acme`), with the host in `identifier`. They land in the
 * file Fairway tails only when the global `log` block sends the default logger to that file.
 * Best effort: only the tail of the log is searched.
 */

import { patternMatches } from "./tls.js";

export interface IssuanceError {
  /** Epoch milliseconds. */
  at: number;
  message: string;
  logger: string;
  issuer?: string;
}

const SUCCESS = /certificate (obtained|renewed) successfully/i;

function timeOf(ts: unknown): number | null {
  if (typeof ts === "number" && Number.isFinite(ts)) return Math.round(ts * 1000);
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function identifiersOf(entry: Record<string, unknown>): string[] {
  const list = Array.isArray(entry.identifiers) ? entry.identifiers : [];
  const single = typeof entry.identifier === "string" ? [entry.identifier] : [];
  return [...single, ...list].filter((v): v is string => typeof v === "string");
}

/** The newest issuance error for `host` in `lines`, unless a later success cleared it. */
export function lastIssuanceError(lines: string[], host: string): IssuanceError | null {
  let latest: IssuanceError | null = null;
  let clearedAt = -Infinity;
  for (const raw of lines) {
    if (!raw.includes('"tls.')) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const logger = entry.logger;
    if (typeof logger !== "string" || !logger.startsWith("tls.")) continue;
    const at = timeOf(entry.ts);
    if (at === null) continue;
    if (!identifiersOf(entry).some((id) => patternMatches(id, host))) continue;

    const msg = typeof entry.msg === "string" ? entry.msg : "";
    if (SUCCESS.test(msg)) {
      clearedAt = Math.max(clearedAt, at);
    } else if (entry.level === "error" && (!latest || at >= latest.at)) {
      latest = {
        at,
        message: typeof entry.error === "string" && entry.error ? entry.error : msg,
        logger,
        ...(typeof entry.issuer === "string" && { issuer: entry.issuer }),
      };
    }
  }
  return latest && latest.at > clearedAt ? latest : null;
}
