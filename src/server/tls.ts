/** What the running Caddy config says about each Site's Certificate. No probing, so no expiry yet. */

import { isAutoRedirect } from "./routes.js";

export type TlsState =
  /** Caddy obtains and renews the Certificate. */
  | "managed"
  /** Obtained at handshake time; never probed. */
  | "on-demand"
  /** Signed by Caddy's own CA, so browsers will not trust it. */
  | "internal"
  /** A Certificate supplied by hand (file, folder, PEM or storage). */
  | "manual"
  /** Served over plain HTTP, so there is no Certificate. */
  | "http-only"
  /** Automatic HTTPS is turned off for this host. */
  | "off"
  /** A managed wildcard Certificate on another host already covers this one. */
  | "wildcard-covered"
  /** The route matches no hostname, so there is nothing to certify. */
  | "none";

export type Challenge = "http" | "tls-alpn" | "dns";

export interface Issuer {
  name: string;
  challenges: Challenge[];
  dnsProvider?: string;
}

export interface HostTls {
  host: string;
  state: TlsState;
  /** The wildcard host, when state is wildcard-covered. */
  coveredBy?: string;
  /** Empty unless Caddy obtains the Certificate itself. */
  issuers: Issuer[];
  reason?: string;
}

export interface SiteTls {
  hosts: HostTls[];
}

type Json = Record<string, unknown>;

interface Route {
  match?: Json[];
}

interface Server {
  listen?: string[];
  routes?: Route[];
  automatic_https?: {
    disable?: boolean;
    disable_certificates?: boolean;
    skip?: string[];
    skip_certificates?: string[];
  };
}

interface Policy {
  subjects?: string[];
  issuers?: Json[];
  on_demand?: boolean;
}

export interface TlsApp {
  automation?: { policies?: Policy[] };
  certificates?: Record<string, unknown>;
}

const MANUAL_LOADERS = ["load_files", "load_folders", "load_pem", "load_storage"];

const CA_NAMES: [string, string][] = [
  ["acme-v02.api.letsencrypt.org", "Let's Encrypt"],
  ["acme-staging-v02.api.letsencrypt.org", "Let's Encrypt (staging)"],
  ["acme.zerossl.com", "ZeroSSL"],
  ["dv.acme-v02.api.pki.goog", "Google Trust Services"],
];

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];

/** Does a host pattern (exact, or `*.example.com` covering exactly one label) match a host? */
export function patternMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p === h) return true;
  if (!p.startsWith("*.")) return false;
  const rest = p.slice(1); // ".example.com"
  return h.length > rest.length && h.endsWith(rest) && !h.slice(0, -rest.length).includes(".");
}

/** Hosts Caddy cannot get a publicly trusted Certificate for, so it signs them itself. */
export function isLocalName(host: string): boolean {
  const h = host.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":")) return true;
  return !h.includes(".") || /\.(localhost|local|internal|home\.arpa)$/.test(h);
}

function portOf(address: string): number | null {
  const match = /:(\d+)(?:\/\w+)?$/.exec(address);
  return match ? Number(match[1]) : null;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function issuerFrom(raw: Json): Issuer {
  const module = String(raw.module ?? "acme");
  const challenges = (raw.challenges ?? {}) as Record<string, Json | undefined>;
  const dns = challenges.dns;
  const plain: Challenge[] = [];
  if (!challenges.http?.disabled) plain.push("http");
  if (!challenges["tls-alpn"]?.disabled) plain.push("tls-alpn");
  const provider = (dns?.provider as Json | undefined)?.name;
  const kinds: Challenge[] = dns ? ["dns", ...plain] : plain;
  let name: string;
  if (module === "internal") name = "Caddy internal CA";
  else if (module === "zerossl") name = "ZeroSSL";
  else if (module === "acme") {
    const ca = typeof raw.ca === "string" ? raw.ca : "";
    name = ca ? (CA_NAMES.find(([needle]) => ca.includes(needle))?.[1] ?? hostOf(ca)) : "Let's Encrypt";
  } else name = module;
  return {
    name,
    challenges: module === "internal" ? [] : kinds,
    ...(typeof provider === "string" && { dnsProvider: provider }),
  };
}

/** Caddy's default when no policy says otherwise. */
const DEFAULT_ISSUERS: Issuer[] = [
  { name: "Let's Encrypt", challenges: ["http", "tls-alpn"] },
  { name: "ZeroSSL", challenges: ["http", "tls-alpn"] },
];

/** The first policy naming the host wins, else the catch-all, as in Caddy. */
function policyFor(host: string, policies: Policy[]): Policy | undefined {
  const named = policies.find((p) => (p.subjects ?? []).some((s) => patternMatches(s, host)));
  return named ?? policies.find((p) => (p.subjects ?? []).length === 0);
}

function describeHost(host: string, server: Server, tls: TlsApp): HostTls {
  const base = { host, issuers: [] as Issuer[] };
  if (host === "*") return { ...base, state: "none", reason: "The route matches no hostname." };

  const auto = server.automatic_https ?? {};
  if (auto.disable) return { ...base, state: "off", reason: "Automatic HTTPS is turned off for this server." };

  const ports = (server.listen ?? []).map(portOf);
  if (ports.length > 0 && ports.every((port) => port === 80)) {
    return { ...base, state: "http-only", reason: "The server listens only on the HTTP port." };
  }
  if ((auto.skip ?? []).some((pattern) => patternMatches(pattern, host))) {
    return { ...base, state: "off", reason: "Automatic HTTPS skips this host." };
  }
  if (auto.disable_certificates || (auto.skip_certificates ?? []).some((pattern) => patternMatches(pattern, host))) {
    const manual = MANUAL_LOADERS.some((key) => tls.certificates?.[key] !== undefined);
    return manual
      ? { ...base, state: "manual", reason: "Caddy does not manage this host's Certificate; one is loaded by hand." }
      : { ...base, state: "off", reason: "Certificate management is turned off for this host." };
  }

  const policy = policyFor(host, tls.automation?.policies ?? []);
  const configured = policy?.issuers ?? [];
  const issuers = configured.length > 0 ? configured.map(issuerFrom) : DEFAULT_ISSUERS;
  if (configured.length > 0 && configured.every((i) => i.module === "internal")) {
    return { ...base, state: "internal", issuers, reason: "Signed by Caddy's own CA." };
  }
  if (isLocalName(host)) {
    return { ...base, state: "internal", reason: "A local name, so Caddy signs it with its own CA." };
  }
  if (policy?.on_demand) {
    return { ...base, state: "on-demand", issuers, reason: "Obtained on the first request. Never probed." };
  }
  return { ...base, state: "managed", issuers };
}

const hostsOf = (route: Route): string[] => (route.match ?? []).flatMap((set) => stringList(set.host));

export function summarizeTls(
  servers: Record<string, unknown> | null | undefined,
  tls: TlsApp | null | undefined,
): SiteTls[] {
  const app = tls ?? {};
  const sites: SiteTls[] = [];
  for (const server of Object.values(servers ?? {}) as Server[]) {
    if (isAutoRedirect(server)) continue;
    for (const route of server.routes ?? []) {
      const hosts = hostsOf(route);
      sites.push({ hosts: (hosts.length > 0 ? hosts : ["*"]).map((host) => describeHost(host, server, app)) });
    }
  }

  const wildcards = sites.flatMap((site) => site.hosts).filter((h) => h.state === "managed" && h.host.startsWith("*."));
  for (const site of sites) {
    site.hosts = site.hosts.map((entry): HostTls => {
      if (entry.state !== "managed" || entry.host.startsWith("*.")) return entry;
      const cover = wildcards.find((w) => patternMatches(w.host, entry.host));
      return cover
        ? {
            host: entry.host,
            state: "wildcard-covered",
            coveredBy: cover.host,
            issuers: cover.issuers,
            reason: `Covered by the ${cover.host} Certificate.`,
          }
        : entry;
    });
  }
  return sites.sort((a, b) => a.hosts[0].host.localeCompare(b.hosts[0].host));
}
