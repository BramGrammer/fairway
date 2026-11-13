import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReviewInterval } from "../src/server/ai-settings.js";
import { CHECK_MS, GRACE_MS, ReviewSchedule } from "../src/server/review-schedule.js";

const HOUR = 3_600_000;
const T0 = Date.UTC(2030, 0, 1);

function rig(options: { interval?: ReviewInterval; ready?: boolean; login?: boolean; last?: number | null; running?: boolean } = {}) {
  const state = { now: T0, last: options.last ?? null, running: options.running ?? false, interval: options.interval ?? "24h", ready: options.ready ?? true, starts: 0, retryAt: null as number | null, triggers: [] as string[] };
  let ticker: (() => void) | null = null;
  let cancelled = false;
  const schedule = new ReviewSchedule({
    reviews: {
      running: () => state.running,
      lastStartedAt: () => state.last,
      retryAt: () => state.retryAt,
      start: async (trigger: "schedule" | "retry") => {
        state.triggers.push(trigger);
        state.starts += 1;
        state.last = state.now;
      },
    },
    settings: { reviewInterval: () => state.interval, ready: () => ({ review: state.ready }) },
    loginRequired: options.login ?? true,
    now: () => state.now,
    schedule: (fn, ms) => {
      assert.equal(ms, CHECK_MS);
      ticker = fn;
      return () => {
        cancelled = true;
      };
    },
  });
  return { state, schedule, fire: () => ticker?.(), cancelled: () => cancelled };
}

describe("when a scheduled Review is due", () => {
  it("runs when the interval has passed since the last Review started, not before", async () => {
    const r = rig({ last: T0 - 20 * HOUR });
    r.schedule.start();
    r.state.now = T0 + 3 * HOUR;
    await r.schedule.tick();
    assert.equal(r.state.starts, 0);
    r.state.now = T0 + 4 * HOUR;
    await r.schedule.tick();
    assert.equal(r.state.starts, 1);
    await r.schedule.tick();
    assert.equal(r.state.starts, 1);
  });

  it("is pushed back by a Review started by hand", async () => {
    const r = rig({ last: T0 - 23 * HOUR });
    r.schedule.start();
    r.state.last = T0 + 30 * 60_000; // the Owner pressed Review now
    r.state.now = T0 + 2 * HOUR;
    await r.schedule.tick();
    assert.equal(r.state.starts, 0);
    assert.equal(r.schedule.status().nextAt, T0 + 30 * 60_000 + 24 * HOUR);
  });

  it("runs an overdue Review after a restart, but not in the first moments", async () => {
    const r = rig({ last: T0 - 3 * 24 * HOUR });
    r.schedule.start();
    r.state.now = T0 + CHECK_MS;
    await r.schedule.tick();
    assert.equal(r.state.starts, 0);
    r.state.now = T0 + GRACE_MS;
    await r.schedule.tick();
    assert.equal(r.state.starts, 1);
  });

  it("waits while a Review is running", async () => {
    const r = rig({ last: null, running: true });
    r.schedule.start();
    r.state.now = T0 + HOUR;
    await r.schedule.tick();
    assert.equal(r.state.starts, 0);
  });

  it("follows the interval: 6 hours, weekly", async () => {
    const six = rig({ interval: "6h", last: T0 });
    six.schedule.start();
    assert.equal(six.schedule.status().nextAt, T0 + 6 * HOUR);
    const week = rig({ interval: "weekly", last: T0 });
    assert.equal(week.schedule.status().nextAt, T0 + 7 * 24 * HOUR);
  });

  it("runs a pending retry when it is due, marked as one, and puts it in the status", async () => {
    const r = rig({ last: T0 - HOUR });
    r.schedule.start();
    r.state.retryAt = T0 + 40 * 60_000;
    assert.deepEqual([r.schedule.status().nextAt, r.schedule.status().retrying], [T0 + 40 * 60_000, true]);
    r.state.now = T0 + 39 * 60_000;
    await r.schedule.tick();
    assert.equal(r.state.starts, 0);
    r.state.now = T0 + 40 * 60_000;
    await r.schedule.tick();
    assert.deepEqual(r.state.triggers, ["retry"]);
  });

  it("starts the regular Review, not a retry, when that is due before the retry", async () => {
    const r = rig({ last: T0 - 24 * HOUR + 10 * 60_000 });
    r.schedule.start();
    r.state.retryAt = T0 + HOUR;
    assert.equal(r.schedule.status().retrying, false);
    r.state.now = T0 + 10 * 60_000;
    await r.schedule.tick();
    assert.deepEqual(r.state.triggers, ["schedule"]);
  });

  it("does nothing when off, without a login, or without a Reviews model, and says why", async () => {
    const off = rig({ interval: "off" });
    off.schedule.start();
    off.state.now = T0 + 100 * HOUR;
    await off.schedule.tick();
    assert.equal(off.state.starts, 0);
    assert.deepEqual(off.schedule.status(), { interval: "off", active: false, idleReason: null, nextAt: null, retrying: false });
    const noLogin = rig({ login: false });
    assert.match(noLogin.schedule.status().idleReason ?? "", /Sign in/);
    const noModel = rig({ ready: false });
    noModel.state.now = T0 + 100 * HOUR;
    await noModel.schedule.tick();
    assert.equal(noModel.state.starts, 0);
    assert.match(noModel.schedule.status().idleReason ?? "", /model/);
  });

  it("checks on the timer and stops when stopped", async () => {
    const r = rig();
    r.schedule.start();
    r.state.now = T0 + GRACE_MS;
    r.fire();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(r.state.starts, 1);
    r.schedule.stop();
    assert.equal(r.cancelled(), true);
  });
});
