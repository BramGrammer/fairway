/** Probes Caddy's own TLS port to see the Certificate visitors actually get. See ADR 0003. */

import tls from "node:tls";
import { patternMatches, type TlsState } from "./tls.js";

export interface CertInfo {
  issuer: string;
  subject: string;
  /** DNS names the Certificate covers. */
  names: string[];
  notBefore: string;
  notAfter: string;
}

export type ProbeResult = { ok: true; cert: CertInfo } | { ok: false; error: string };

export type Severity = "ok" | "amber" | "red";

export interface Assessment {
  severity: Severity;
  reasons: string[];
  /** Whole days until expiry, negative once expired. Absent on a failed handshake. */
  daysLeft?: number;
}

export interface ProbeTarget {
  host: string;
  port: number;
}

const DAY = 86_400_000;
export const CACHE_MS = 10 * 60_000;
/** Caddy renews about 30 days out, so less than this means a renewal is failing. */
export const AMBER_DAYS = 21;
export const RED_DAYS = 7;

/** `host`, `host:port` or `[v6]:port`; the port defaults to 443. */
export function parseProbeAddr(raw: string): ProbeTarget | null {
  const match = /^(?:\[([^\]]+)\]|([^:\s]+))(?::(\d+))?$/.exec(raw.trim());
  if (!match) return null;
  return { host: match[1] ?? match[2], port: match[3] ? Number(match[3]) : 443 };
}

/** Why a host must not be probed, or null when it may be. A handshake can trigger issuance, so be strict. */
export function probeEligibility(host: string, state: TlsState): string | null {
  if (host.startsWith("*")) return "A wildcard has no hostname to probe.";
  switch (state) {
    case "managed":
    case "internal":
    case "manual":
      return null;
    case "on-demand":
      return "On-demand hosts are never probed, because a handshake could trigger issuance.";
    case "http-only":
      return "Served over plain HTTP, so there is nothing to probe.";
    case "wildcard-covered":
      return "Covered by a wildcard Certificate; probe the wildcard's own host instead.";
    default:
      return "Caddy does not manage a Certificate for this host.";
  }
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export function probeCertificate(target: ProbeTarget, servername: string, timeoutMs = 5000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = tls.connect({
      host: target.host,
      port: target.port,
      // An IP literal is not a valid SNI value, and we always want the Site's name here.
      servername,
      // Only the Certificate matters; a fallback certificate is itself a finding, so trust is irrelevant.
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });
    socket.on("secureConnect", () => {
      const peer = socket.getPeerCertificate();
      if (!peer?.valid_to) return done({ ok: false, error: "The server presented no certificate." });
      const names = (peer.subjectaltname ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.startsWith("DNS:"))
        .map((part) => part.slice(4));
      const cn = first(peer.subject?.CN);
      done({
        ok: true,
        cert: {
          issuer: first(peer.issuer?.O) ?? first(peer.issuer?.CN) ?? "Unknown issuer",
          subject: cn ?? "",
          names: names.length > 0 ? names : cn ? [cn] : [],
          notBefore: new Date(peer.valid_from).toISOString(),
          notAfter: new Date(peer.valid_to).toISOString(),
        },
      });
    });
    socket.on("timeout", () => done({ ok: false, error: "The handshake timed out." }));
    socket.on("error", (error) => done({ ok: false, error: error.message }));
  });
}

export function assessProbe(result: ProbeResult, host: string, now: number): Assessment {
  if (!result.ok) return { severity: "red", reasons: [`Handshake failed: ${result.error}`] };
  const { cert } = result;
  const reasons: string[] = [];
  let severity: Severity = "ok";
  const raise = (level: Severity, reason: string) => {
    reasons.push(reason);
    if (level === "red" || severity === "ok") severity = level;
  };

  const daysLeft = Math.floor((Date.parse(cert.notAfter) - now) / DAY);
  if (daysLeft < 0) raise("red", "The Certificate has expired.");
  else if (daysLeft < RED_DAYS) raise("red", `Expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`);
  else if (daysLeft < AMBER_DAYS) {
    raise("amber", `Expires in ${daysLeft} days; Caddy renews about 30 days out, so a renewal is probably failing.`);
  }
  if (!cert.names.some((name) => patternMatches(name, host))) {
    raise("amber", "Caddy served a Certificate for a different name, probably its fallback Certificate.");
  }
  return { severity, reasons, daysLeft };
}

export interface HostProbe {
  result: ProbeResult;
  assessment: Assessment;
  checkedAt: string;
  cached: boolean;
}

interface ProbeOptions {
  /** `TLS_PROBE_ADDR`; null or empty disables probing. */
  addr: string | null;
  probe?: (target: ProbeTarget, host: string) => Promise<ProbeResult>;
  now?: () => number;
}

export class TlsProber {
  private readonly target: ProbeTarget | null;
  private readonly probe: NonNullable<ProbeOptions["probe"]>;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; result: ProbeResult }>();

  constructor(options: ProbeOptions) {
    this.target = options.addr ? parseProbeAddr(options.addr) : null;
    this.probe = options.probe ?? ((target, host) => probeCertificate(target, host));
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.target !== null;
  }

  async check(host: string, { force = false }: { force?: boolean } = {}): Promise<HostProbe> {
    if (!this.target) throw new Error("TLS probing is not configured.");
    const key = host.toLowerCase();
    const hit = this.cache.get(key);
    if (!force && hit && this.now() - hit.at < CACHE_MS) {
      return this.wrap(host, hit.result, hit.at, true);
    }
    const result = await this.probe(this.target, host);
    const at = this.now();
    this.cache.set(key, { at, result });
    return this.wrap(host, result, at, false);
  }

  private wrap(host: string, result: ProbeResult, at: number, cached: boolean): HostProbe {
    return {
      result,
      assessment: assessProbe(result, host, this.now()),
      checkedAt: new Date(at).toISOString(),
      cached,
    };
  }
}
