/**
 * Runs a Review when one is due (ADR 0009). It looks about once a minute: a Review is due when none is running
 * and the interval has passed since the last one started, by the schedule or by hand. The same rule holds after a
 * restart, since the last start is read from the stored Reviews; a short grace period after start lets Caddy's
 * configuration load first.
 */

import { REVIEW_INTERVAL_MS, type ReviewInterval } from "./ai-settings.js";

export const CHECK_MS = 60_000;
export const GRACE_MS = 2 * 60_000;

export interface ScheduleStatus {
  interval: ReviewInterval;
  /** Whether Reviews will run by themselves. False when the interval is off or the Reviews task is not ready. */
  active: boolean;
  /** Why it is not active; null when it is. */
  idleReason: string | null;
  /** When the next Review is due, epoch milliseconds; null when not active. Not later than now means due at the next check. */
  nextAt: number | null;
  /** True when `nextAt` is the retry of a failed scheduled Review, not the regular next one. */
  retrying: boolean;
}

export interface ReviewScheduleOptions {
  reviews: { running(): boolean; lastStartedAt(): number | null; retryAt(): number | null; start(trigger: "schedule" | "retry"): Promise<unknown> };
  settings: { reviewInterval(): ReviewInterval; ready(): { review: boolean } };
  loginRequired: boolean;
  now?: () => number;
  /** Calls `fn` every `ms` until the returned function is called. */
  schedule?: (fn: () => void, ms: number) => () => void;
  graceMs?: number;
}

const defaultSchedule: NonNullable<ReviewScheduleOptions["schedule"]> = (fn, ms) => {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
};

export class ReviewSchedule {
  private cancel: (() => void) | null = null;
  private begunAt = 0;
  private starting = false;

  constructor(private readonly options: ReviewScheduleOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  start(): void {
    if (this.cancel) return;
    this.begunAt = this.now();
    this.cancel = (this.options.schedule ?? defaultSchedule)(() => void this.tick(), CHECK_MS);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  status(): ScheduleStatus {
    const interval = this.options.settings.reviewInterval();
    const ms = REVIEW_INTERVAL_MS[interval];
    const idle = (idleReason: string | null): ScheduleStatus => ({ interval, active: false, idleReason, nextAt: null, retrying: false });
    if (ms === null) return idle(null);
    if (!this.options.loginRequired) return idle("Sign in is required, so set AUTH_USER and a password first.");
    if (!this.options.settings.ready().review) return idle("Choose a model for Reviews in Settings first.");
    const last = this.options.reviews.lastStartedAt();
    const regular = last === null ? this.begunAt : last + ms;
    const retry = this.options.reviews.retryAt();
    const retrying = retry !== null && retry < regular;
    const due = retrying ? retry : regular;
    return { interval, active: true, idleReason: null, nextAt: Math.max(due, this.begunAt + (this.options.graceMs ?? GRACE_MS)), retrying };
  }

  /** One check. Starts a Review when one is due; for the timer and for tests. */
  async tick(): Promise<void> {
    if (this.starting) return;
    const status = this.status();
    if (!status.active || status.nextAt === null || this.now() < status.nextAt || this.options.reviews.running()) return;
    this.starting = true;
    try {
      await this.options.reviews.start(status.retrying ? "retry" : "schedule");
    } finally {
      this.starting = false;
    }
  }
}
