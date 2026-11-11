import type { Warning } from "./caddy-admin.js";

/** One thing Validation has to say about a Caddyfile, from Caddy or from Fairway's own rules. */
export interface Finding {
  level: "error" | "warning";
  message: string;
  /** 1-based line in the Caddyfile, when known. */
  line?: number;
  origin: "caddy" | "rules";
}

export interface ValidateResult {
  /** False when Caddy rejected the Caddyfile; Deploy refuses then. */
  ok: boolean;
  findings: Finding[];
}

const ADAPT_PREFIX = /^adapting config using caddyfile adapter: /;
// Two shapes: "Caddyfile:2: unrecognized directive: foo" and "..., at Caddyfile:2 import chain: ['']".
const LEADING_LINE = /^Caddyfile:(\d+): /;
const TRAILING_LINE = /,? at Caddyfile:(\d+)(?: import chain: \[[^\]]*\])?\s*$/;

/** Turns Caddy's rejection message into an error Finding, reading its line when it names one. */
export function errorFinding(raw: string): Finding {
  let message = raw.trim().replace(ADAPT_PREFIX, "");
  let line: number | undefined;
  const leading = LEADING_LINE.exec(message);
  if (leading) {
    line = Number(leading[1]);
    message = message.slice(leading[0].length);
  } else {
    const trailing = TRAILING_LINE.exec(message);
    if (trailing) {
      line = Number(trailing[1]);
      message = message.slice(0, trailing.index);
    }
  }
  if (line !== undefined && line < 1) line = undefined;
  return { level: "error", message, origin: "caddy", ...(line !== undefined && { line }) };
}

export function warningFinding(warning: Warning): Finding {
  const line = warning.line;
  return {
    level: "warning",
    message: warning.message,
    origin: "caddy",
    ...(typeof line === "number" && line > 0 && { line }),
  };
}
