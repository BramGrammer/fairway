/** What sends an Alert and how long things must hold, as the Owner can set them. */

/** What sends an Alert regardless of host. Certificates, upstreams and the host check are chosen per host instead. */
export const TRIGGER_KEYS = ["caddy", "deploy_failed", "external_edit", "review_failed", "rollback", "recovery", "flapping"] as const;
export type TriggerKey = (typeof TRIGGER_KEYS)[number];

/** The lowest level of Observation that makes a Review send an Alert, or never. Ordered from the lowest. */
export const REVIEW_LEVELS = ["info", "notable", "urgent", "never"] as const;
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

export interface AlertPolicy {
  /** Which occurrences send an Alert. `recovery` and `flapping` apply on top of the occurrence itself. */
  triggers: Record<TriggerKey, boolean>;
  /** A Review with a new Observation at or above this level records an Event and sends an Alert. */
  reviewLevel: ReviewLevel;
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
    caddy: true,
    deploy_failed: true,
    external_edit: true,
    review_failed: true,
    rollback: false, // you just did it yourself
    recovery: true,
    flapping: true,
  },
  reviewLevel: "urgent",
  caddyHoldSec: 15,
  upstreamHoldSec: 60,
  flapChanges: 4,
  flapStableMin: 30,
};
