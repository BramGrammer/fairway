/** Background sweep that probes every eligible host so Certificate problems show up without opening a drawer. */

import type { HostProbe, Severity } from "./tls-probe.js";

export const SWEEP_MS = 6 * 3_600_000;

export interface SweepHost {
  severity: Severity;
  reasons: string[];
}

export interface SweepSnapshot {
  ok: true;
  enabled: boolean;
  /** When the last sweep finished; absent before the first one. */
  sweptAt?: string;
  hosts: Record<string, SweepHost>;
}

interface SweepOptions {
  prober: { enabled: boolean; check(host: string, options?: { force?: boolean }): Promise<HostProbe> };
  /** The hosts the probe rules allow (see `probeEligibility`). */
  listHosts: () => Promise<string[]>;
  now?: () => number;
  /** Called with every finished sweep's results. */
  onSwept?: (hosts: Record<string, SweepHost>) => void;
  /** Calls `fn` every `ms` until the returned function is called. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

const defaultSchedule: NonNullable<SweepOptions["schedule"]> = (fn, ms) => {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
};

export class TlsSweep {
  private readonly options: SweepOptions;
  private hosts: Record<string, SweepHost> = {};
  private sweptAt: string | undefined;
  private running: Promise<void> | null = null;
  private cancel: (() => void) | null = null;

  constructor(options: SweepOptions) {
    this.options = options;
  }

  /** Sweeps now, then every 6 hours. Does nothing when probing is not configured. */
  async start(): Promise<void> {
    if (!this.options.prober.enabled || this.cancel) return;
    this.cancel = (this.options.schedule ?? defaultSchedule)(() => void this.sweepOnce(), SWEEP_MS);
    await this.sweepOnce();
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  /** Runs one sweep; a call while another is in flight joins it. */
  sweepOnce(): Promise<void> {
    if (!this.options.prober.enabled) return Promise.resolve();
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  snapshot(): SweepSnapshot {
    return { ok: true, enabled: this.options.prober.enabled, ...(this.sweptAt && { sweptAt: this.sweptAt }), hosts: this.hosts };
  }

  private async run(): Promise<void> {
    let list: string[];
    try {
      list = await this.options.listHosts();
    } catch {
      return; // Caddy unreachable: keep what we knew.
    }
    const next: Record<string, SweepHost> = {};
    for (const host of list) {
      try {
        const { assessment } = await this.options.prober.check(host, { force: true });
        next[host] = { severity: assessment.severity, reasons: assessment.reasons };
      } catch {
        // One failing host must not stop the sweep.
      }
    }
    this.hosts = next;
    this.sweptAt = new Date((this.options.now ?? Date.now)()).toISOString();
    this.options.onSwept?.(next);
  }
}
