import type { CaddyAdmin } from "./caddy-admin.js";

export interface Counters {
  /** Requests seen since Caddy started. */
  total: number;
  codes: { "2xx": number; "3xx": number; "4xx": number; "5xx": number; other: number };
  bytes: number;
  /** Total seconds spent serving, for averages. */
  seconds: number;
  inFlight: number;
}

/** What happened during a window of time, for one host. */
export interface HostStats {
  requests: number;
  codes: Counters["codes"];
  bytes: number;
  /** Mean response time over the window. */
  avgMs: number;
  /** Requests being served right now. */
  inFlight: number;
  /** Requests per second over the last half minute. */
  rate: number;
  /** Requests per time slice across the window, oldest first. */
  history: number[];
}

export type MetricsSnapshot =
  | {
      ok: true;
      enabled: boolean;
      perHost: boolean;
      windowMs: number;
      /** How much of the window the editor has actually been watching. */
      coveredMs: number;
      hosts: Record<string, HostStats>;
    }
  | { ok: false; error: string };

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\{([^}]*)\}\s+(\S+)$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

const empty = (): Counters => ({
  total: 0,
  codes: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 },
  bytes: 0,
  seconds: 0,
  inFlight: 0,
});

function codeClass(code: string): keyof Counters["codes"] {
  const first = code[0];
  return first === "2" || first === "3" || first === "4" || first === "5" ? (`${first}xx` as keyof Counters["codes"]) : "other";
}

/** Per-host counters from Caddy's Prometheus text, summed over server, handler and method. */
export function parseMetrics(text: string): Map<string, Counters> {
  const hosts = new Map<string, Counters>();
  const get = (host: string) => {
    let counters = hosts.get(host);
    if (!counters) hosts.set(host, (counters = empty()));
    return counters;
  };
  for (const line of text.split("\n")) {
    if (!line.startsWith("caddy_http_")) continue;
    const match = LINE.exec(line);
    if (!match) continue;
    const [, name, rawLabels, rawValue] = match;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    const labels: Record<string, string> = {};
    for (const label of rawLabels.matchAll(LABEL)) labels[label[1]] = label[2];
    const host = labels.host;
    if (host === undefined) continue; // per_host is off: only per-server series exist

    switch (name) {
      case "caddy_http_request_duration_seconds_count": {
        const counters = get(host);
        counters.total += value;
        counters.codes[codeClass(labels.code ?? "")] += value;
        break;
      }
      case "caddy_http_request_duration_seconds_sum":
        get(host).seconds += value;
        break;
      case "caddy_http_response_size_bytes_sum":
        get(host).bytes += value;
        break;
      case "caddy_http_requests_in_flight":
        get(host).inFlight += value;
        break;
    }
  }
  return hosts;
}

interface Delta {
  n: number;
  seconds: number;
  bytes: number;
  codes: Counters["codes"];
}

const zero = (): Delta => ({ n: 0, seconds: 0, bytes: 0, codes: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 } });

function add(into: Delta, delta: Delta): void {
  into.n += delta.n;
  into.seconds += delta.seconds;
  into.bytes += delta.bytes;
  for (const key of Object.keys(into.codes) as (keyof Delta["codes"])[]) into.codes[key] += delta.codes[key];
}

/** Growth since the previous sample. A counter that went down means Caddy restarted, so count from zero. */
function growth(now: Counters, before: Counters | undefined): Delta {
  if (!before || now.total < before.total) return { n: now.total, seconds: now.seconds, bytes: now.bytes, codes: { ...now.codes } };
  const codes = { ...now.codes };
  for (const key of Object.keys(codes) as (keyof Delta["codes"])[]) codes[key] = Math.max(0, now.codes[key] - before.codes[key]);
  return { n: now.total - before.total, seconds: now.seconds - before.seconds, bytes: Math.max(0, now.bytes - before.bytes), codes };
}

interface Slice {
  /** When the slice ended (a sample) or began (a bucket), in ms. */
  t: number;
  delta: Map<string, Delta>;
}

export const WINDOWS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 24 * 60 * 60_000] as const;

const FINE_KEEP_MS = 60 * 60_000; // samples, up to an hour back
const BUCKET_MS = 60_000; // then one-minute buckets, up to a day back
const COARSE_KEEP_MS = 24 * 60 * 60_000;
const RATE_MS = 30_000;
const POINTS = 60;

/** Samples Caddy's metrics on a timer and keeps rolling history, so the UI can show a recent window instead of totals since start. */
export class MetricsTracker {
  private previous: Map<string, Counters> | null = null;
  private current = new Map<string, Counters>();
  private samples: Slice[] = [];
  private buckets: Slice[] = [];
  private since: number | null = null;
  private config: { perHost: boolean } | null = null;
  private error: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly admin: CaddyAdmin,
    private readonly intervalMs = 5000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    try {
      this.config = await this.admin.metricsConfig();
      this.ingest(this.config ? await this.admin.metricsText() : "");
      this.error = null;
    } catch (error) {
      this.error = `Cannot reach Caddy: ${(error as Error).message}`;
    }
  }

  /** Records one sample. The first only sets the baseline. */
  ingest(text: string, now = Date.now()): void {
    const sample = parseMetrics(text);
    this.since ??= now;
    if (this.previous) {
      const delta = new Map<string, Delta>();
      for (const [host, counters] of sample) delta.set(host, growth(counters, this.previous.get(host)));

      this.samples.push({ t: now, delta });
      while (this.samples.length > 0 && this.samples[0].t < now - FINE_KEEP_MS) this.samples.shift();

      const start = Math.floor(now / BUCKET_MS) * BUCKET_MS;
      let bucket = this.buckets[this.buckets.length - 1];
      if (!bucket || bucket.t !== start) this.buckets.push((bucket = { t: start, delta: new Map() }));
      for (const [host, d] of delta) {
        const total = bucket.delta.get(host) ?? zero();
        add(total, d);
        bucket.delta.set(host, total);
      }
      while (this.buckets.length > 0 && this.buckets[0].t < now - COARSE_KEEP_MS) this.buckets.shift();
    }
    this.previous = sample;
    this.current = sample;
  }

  snapshot(windowMs: number = WINDOWS_MS[0], now = Date.now()): MetricsSnapshot {
    if (this.error) return { ok: false, error: this.error };

    const from = now - windowMs;
    // Short windows read the fine samples; longer ones read the minute buckets.
    const slices =
      windowMs <= FINE_KEEP_MS
        ? this.samples.filter((slice) => slice.t > from)
        : this.buckets.filter((slice) => slice.t + BUCKET_MS > from);
    const recent = this.samples.filter((slice) => slice.t > now - RATE_MS);
    const rateSeconds = Math.max(Math.min(RATE_MS, now - (this.since ?? now)), this.intervalMs) / 1000;

    const hosts: Record<string, HostStats> = {};
    for (const [host, counters] of this.current) {
      const total = zero();
      const history = new Array<number>(POINTS).fill(0);
      for (const slice of slices) {
        const delta = slice.delta.get(host);
        if (!delta) continue;
        add(total, delta);
        const index = Math.min(POINTS - 1, Math.max(0, Math.floor(((slice.t - from) / windowMs) * POINTS)));
        history[index] += delta.n;
      }
      const rate = recent.reduce((sum, slice) => sum + (slice.delta.get(host)?.n ?? 0), 0) / rateSeconds;
      hosts[host] = {
        requests: total.n,
        codes: total.codes,
        bytes: total.bytes,
        avgMs: total.n > 0 ? (total.seconds / total.n) * 1000 : 0,
        inFlight: counters.inFlight,
        rate,
        history,
      };
    }
    return {
      ok: true,
      enabled: this.config !== null,
      perHost: this.config?.perHost === true,
      windowMs,
      coveredMs: Math.min(windowMs, now - (this.since ?? now)),
      hosts,
    };
  }
}
