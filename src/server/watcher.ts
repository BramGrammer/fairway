/** Feeds the event log with what Caddy reports: whether it answers, and whether its upstreams are healthy. */

import type { EventTracker } from "./events.js";

const LINE = /^caddy_reverse_proxy_upstreams_healthy\{([^}]*)\}\s+(\S+)$/;
const UPSTREAM_LABEL = /upstream="((?:[^"\\]|\\.)*)"/;

/** The address Fairway uses as an upstream's name: no scheme, as Caddy's dial address. */
export const upstreamKey = (address: string) => `upstream:${address.replace(/^https?:\/\//, "")}`;

/**
 * Health per upstream from Caddy's Prometheus text. Caddy only reports it for upstreams with an active
 * health check; the rest are absent, not unhealthy.
 */
export function parseUpstreamHealth(text: string): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const line of text.split("\n")) {
    if (!line.startsWith("caddy_reverse_proxy_upstreams_healthy")) continue;
    const match = LINE.exec(line);
    const upstream = match && UPSTREAM_LABEL.exec(match[1])?.[1];
    if (!match || !upstream) continue;
    result[upstreamKey(upstream)] = match[2] === "1";
  }
  return result;
}

export interface WatcherSource {
  ping(): Promise<boolean>;
  /** Prometheus text, or null when it cannot be read. */
  metricsText(): Promise<string | null>;
}

export const WATCH_MS = 5_000;

export class Watcher {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly events: EventTracker,
    private readonly source: WatcherSource,
    private readonly intervalMs = WATCH_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = Date.now()): Promise<void> {
    this.events.beat(now);
    const up = await this.source.ping();
    this.events.observe("caddy", up ? "ok" : "down", up ? undefined : "the admin API does not answer", now);
    if (!up) return; // what Caddy last said about upstreams stays true until it answers again

    const text = await this.source.metricsText();
    if (text === null) return;
    const health = parseUpstreamHealth(text);
    for (const [subject, healthy] of Object.entries(health)) this.events.observe(subject, healthy ? "ok" : "down", undefined, now);
    this.events.sync("upstream", Object.keys(health), now);
  }
}
