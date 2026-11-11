/** Opt-in synthetic check: one HTTPS GET to each eligible host so a dead app shows as down without a health check. */

import https from "node:https";
import type { StateName, SubjectKind } from "./events.js";
import { parseProbeAddr, type ProbeTarget } from "./tls-probe.js";

export const CHECK_MS = 5 * 60_000;
export const REQUEST_TIMEOUT_MS = 10_000;
const CONCURRENCY = 4;
/** Statuses that mean the proxy could not reach the app. Any other status counts as the app answering. */
const DOWN_STATUSES = new Set([502, 503, 504]);

export type RequestResult = { status: number } | { error: string };

export function isDown(result: RequestResult): boolean {
  return "error" in result || DOWN_STATUSES.has(result.status);
}

/** GET `/` on `target` with SNI and Host set to `host`. Never follows redirects; certificate errors are not this check's business. */
export function requestHost(target: ProbeTarget, host: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<RequestResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: RequestResult) => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve(result);
    };
    const req = https.request(
      {
        host: target.host,
        port: target.port,
        method: "GET",
        path: "/",
        servername: isIpLiteral(host) ? undefined : host,
        headers: { host, "user-agent": "fairway-host-check" },
        rejectUnauthorized: false,
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        res.resume();
        done({ status: res.statusCode ?? 0 });
      },
    );
    req.on("timeout", () => done({ error: "timed out" }));
    req.on("error", (error) => done({ error: error.message }));
    req.end();
  });
}

function isIpLiteral(host: string): boolean {
  return /^[\d.]+$/.test(host) || host.includes(":");
}

interface HostCheckOptions {
  /** `TLS_PROBE_ADDR`; null or unparseable keeps the check off. */
  addr: string | null;
  /** `HOST_CHECK`; the check is opt-in. */
  enabled: boolean;
  /** The hosts the probe rules allow (see `probeEligibility`). */
  listHosts: () => Promise<string[]>;
  events: {
    observe(subject: string, state: StateName, detail?: string, now?: number): void;
    sync(kind: SubjectKind, present: Iterable<string>, now?: number): void;
  };
  request?: (target: ProbeTarget, host: string) => Promise<RequestResult>;
  now?: () => number;
  /** Calls `fn` every `ms` until the returned function is called. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

const defaultSchedule: NonNullable<HostCheckOptions["schedule"]> = (fn, ms) => {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
};

export class HostCheck {
  private readonly options: HostCheckOptions;
  private readonly target: ProbeTarget | null;
  private running: Promise<void> | null = null;
  private cancel: (() => void) | null = null;

  constructor(options: HostCheckOptions) {
    this.options = options;
    this.target = options.enabled && options.addr ? parseProbeAddr(options.addr) : null;
  }

  get enabled(): boolean {
    return this.target !== null;
  }

  /** Checks now, then every 5 minutes. Does nothing unless opted in and `TLS_PROBE_ADDR` is set. */
  async start(): Promise<void> {
    if (!this.target || this.cancel) return;
    this.cancel = (this.options.schedule ?? defaultSchedule)(() => void this.runOnce(), CHECK_MS);
    await this.runOnce();
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  /** Runs one pass; a call while another is in flight joins it. */
  runOnce(): Promise<void> {
    if (!this.target) return Promise.resolve();
    this.running ??= this.run(this.target).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(target: ProbeTarget): Promise<void> {
    let list: string[];
    try {
      list = await this.options.listHosts();
    } catch {
      return; // Caddy unreachable: change nothing.
    }
    const { events } = this.options;
    const request = this.options.request ?? requestHost;
    const clock = this.options.now ?? Date.now;
    const queue = [...new Set(list)];
    const worker = async () => {
      for (let host = queue.shift(); host !== undefined; host = queue.shift()) {
        let result: RequestResult;
        try {
          result = await request(target, host);
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        const detail = "error" in result ? result.error : String(result.status);
        events.observe(`host:${host}`, isDown(result) ? "down" : "ok", isDown(result) ? detail : undefined, clock());
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
    events.sync("host", list.map((host) => `host:${host}`), clock());
  }
}
