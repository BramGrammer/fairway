/** What sends an Alert and how long things must hold, as the Owner can set them. */

export const TRIGGER_KEYS = ["cert", "upstream", "caddy", "host", "deploy_failed", "external_edit", "rollback", "recovery", "flapping"] as const;
export type TriggerKey = (typeof TRIGGER_KEYS)[number];

export interface AlertPolicy {
  /** Which occurrences send an Alert. `recovery` and `flapping` apply on top of the kind of Subject. */
  triggers: Record<TriggerKey, boolean>;
  /** How long Caddy must fail to answer before it counts as down. */
  caddyHoldSec: number;
  /** How long an upstream must stay unhealthy before it counts as down. */
  upstreamHoldSec: number;
  /** More than this many State changes of one Subject within an hour is flapping. */
  flapChanges: number;
  /** A flapping Subject is announced as settled after this long without a change. */
  flapStableMin: number;
}

export type TimingKey = "caddyHoldSec" | "upstreamHoldSec" | "flapChanges" | "flapStableMin";
export const TIMING_KEYS: TimingKey[] = ["caddyHoldSec", "upstreamHoldSec", "flapChanges", "flapStableMin"];

export const TIMING_LIMITS: Record<TimingKey, { min: number; max: number }> = {
  caddyHoldSec: { min: 5, max: 600 },
  upstreamHoldSec: { min: 10, max: 3600 },
  flapChanges: { min: 2, max: 20 },
  flapStableMin: { min: 5, max: 1440 },
};

export const DEFAULT_POLICY: AlertPolicy = {
  triggers: {
    cert: true,
    upstream: true,
    caddy: true,
    host: true,
    deploy_failed: true,
    external_edit: true,
    rollback: false, // you just did it yourself
    recovery: true,
    flapping: true,
  },
  caddyHoldSec: 15,
  upstreamHoldSec: 60,
  flapChanges: 4,
  flapStableMin: 30,
};
