import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_POLICY } from "../src/server/alert-policy.js";
import type { AlertPayload, AlertSender } from "../src/server/alerts.js";
import { EventTracker } from "../src/server/events.js";
import { alertOnFinished } from "../src/server/review-alert.js";
import { ReviewSchedule } from "../src/server/review-schedule.js";
import { REPORT_TOOL } from "../src/server/review-result.js";
import { RETRY_DELAY_MS, REVIEW_RETENTION_MS, Reviews } from "../src/server/reviews.js";
import { LINES_TOOL } from "../src/server/review-lines.js";
import { nextReviewLabel } from "../web/src/lib/reviews.js";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2030, 0, 1, 12, 0, 0); // a made-up day
const KEY = "sk-made-up-key-1234";

const logging = { logs: { web: { writer: { output: "file", filename: "/var/log/caddy/web.log" } } } };
const servers = {
  srv0: {
    listen: [":443"],
    logs: { logger_names: { "app.example.test": ["web"] } },
    routes: [{ match: [{ host: ["app.example.test"] }], handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "10.9.8.7:4000" }] }] }],
  },
};
const sse = (...chunks: unknown[]) => new Response([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
const call = (name: string, args: unknown) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name, arguments: JSON.stringify(args) } }] } }] });
const usage = (p: number, c: number) => ({ choices: [], usage: { prompt_tokens: p, completion_tokens: c } });
const good = () => sse(call(REPORT_TOOL, { summary: "Quiet.", observations: [] }), usage(10, 5));

/** The fake endpoint: what it answers is chosen by the test, per request. */
type Answer = () => Response;

async function rig(options: { interval?: "6h" | "24h"; publicUrl?: string | null } = {}) {
  const state = { now: T0, answer: good as Answer, requests: 0 };
  const dir = await mkdtemp(join(tmpdir(), "ce-failures-"));
  await writeFile(join(dir, "web.log"), "");
  const sent: AlertPayload[] = [];
  const sender: AlertSender = { async send(payload) { sent.push(payload); } };
  const events = new EventTracker({ sender, publicUrl: options.publicUrl ?? null, now: () => state.now });
  const make = () =>
    new Reviews({
      file: join(dir, "data", "reviews.json"),
      settings: { model: () => "made-up-model", effective: () => ({ baseUrl: "http://llm.example.test/v1", apiKey: KEY }) },
      loadLive: async () => ({ ok: true, logging, servers }),
      logDir: dir,
      loginRequired: true,
      fetchImpl: (async () => {
        state.requests += 1;
        return state.answer();
      }) as unknown as typeof fetch,
      now: () => state.now,
      onFinished: alertOnFinished({ level: () => "info", record: (found) => events.recordReviewFound(found, state.now), recordFailing: (failing) => events.recordReviewFailing(failing, state.now) }),
    });
  const schedulerFor = (reviews: Reviews) =>
    new ReviewSchedule({
      reviews,
      settings: { reviewInterval: () => options.interval ?? "24h", ready: () => ({ review: true }) },
      loginRequired: true,
      now: () => state.now,
      schedule: () => () => undefined,
      graceMs: 0,
    });
  let reviews = make();
  await reviews.load();
  let schedule = schedulerFor(reviews);
  schedule.start();
  const restart = async () => {
    reviews = make();
    await reviews.load();
    schedule = schedulerFor(reviews);
    schedule.start();
  };
  const manual = async () => {
    const result = await reviews.start("manual");
    await reviews.idle();
    return result;
  };
  const tick = async () => {
    await schedule.tick();
    await reviews.idle();
  };
  return { state, sent, events, dir, restart, manual, tick, get reviews() { return reviews; }, get schedule() { return schedule; } };
}

const refused: Answer = () => new Response("{}", { status: 401 });
const triggers = (r: Awaited<ReturnType<typeof rig>>) => r.reviews.list().reverse().map((x) => `${x.trigger}:${x.status}`);

describe("a failed Review is shown", () => {
  it("is stored as failed with a readable reason", async () => {
    const r = await rig();
    r.state.answer = refused;
    await r.manual();
    const [review] = r.reviews.list();
    assert.equal(review.status, "failed");
    assert.equal(review.failure, "The endpoint refused the key.");
    assert.notEqual(review.finishedAt, null);
  });

  it("keeps the tokens used before the failure", async () => {
    const r = await rig();
    let n = 0;
    r.state.answer = () => (n++ === 0 ? sse(call(LINES_TOOL, { host: "app.example.test" }), usage(700, 30)) : new Response("{}", { status: 500 }));
    await r.manual();
    const [review] = r.reviews.list();
    assert.equal(review.status, "failed");
    assert.deepEqual(review.usage, { promptTokens: 700, completionTokens: 30 });
  });

  it("never holds the key, in the reason or in the Event", async () => {
    const r = await rig({ publicUrl: "https://fairway.example.test" });
    const answers: Answer[] = [
      () => new Response(`{"error":"bad key ${KEY}"}`, { status: 401 }),
      () => new Response(`bad request with ${KEY}`, { status: 400 }),
      () => sse({ choices: [{ delta: { content: `all quiet ${KEY}` } }] }),
    ];
    for (const answer of answers) {
      r.state.answer = answer;
      await r.manual();
    }
    await r.events.flush();
    assert.ok(r.reviews.list().every((x) => x.status === "failed"));
    assert.ok(!JSON.stringify(r.reviews.list()).includes(KEY));
    assert.ok(!JSON.stringify(r.events.list()).includes(KEY));
    assert.ok(!JSON.stringify(r.sent).includes(KEY));
  });
});

describe("a failed scheduled Review is tried again once", () => {
  it("retries an hour after the failure ended, and says so in the schedule", async () => {
    const r = await rig();
    r.state.answer = refused;
    await r.tick(); // the first scheduled Review
    assert.deepEqual(triggers(r), ["schedule:failed"]);
    assert.deepEqual([r.schedule.status().nextAt, r.schedule.status().retrying], [T0 + RETRY_DELAY_MS, true]);
    r.state.now = T0 + 30 * MIN;
    await r.tick();
    assert.equal(r.reviews.list().length, 1);
    assert.equal(nextReviewLabel(r.schedule.status(), r.state.now), "Retrying in about 30 minutes");
    r.state.now = T0 + RETRY_DELAY_MS;
    r.state.answer = good;
    await r.tick();
    assert.deepEqual(triggers(r), ["schedule:failed", "retry:done"]);
    assert.equal(r.schedule.status().retrying, false);
  });

  it("does not retry a failed retry; the regular one follows an interval after the scheduled start", async () => {
    const r = await rig();
    r.state.answer = refused;
    await r.tick();
    r.state.now = T0 + HOUR;
    await r.tick();
    assert.deepEqual(triggers(r), ["schedule:failed", "retry:failed"]);
    r.state.now = T0 + 5 * HOUR;
    await r.tick();
    assert.equal(r.reviews.list().length, 2);
    assert.equal(r.schedule.status().nextAt, T0 + DAY);
    assert.equal(r.schedule.status().retrying, false);
    r.state.now = T0 + DAY;
    await r.tick();
    assert.deepEqual(triggers(r), ["schedule:failed", "retry:failed", "schedule:failed"]);
  });

  it("never retries a Review started by hand", async () => {
    const r = await rig();
    r.state.answer = refused;
    await r.manual();
    assert.equal(r.reviews.retryAt(), null);
    r.state.now = T0 + 2 * HOUR;
    await r.tick();
    assert.equal(r.reviews.list().length, 1);
  });

  it("keeps a pending retry when a Review started by hand fails too", async () => {
    const r = await rig();
    r.state.answer = refused;
    await r.tick();
    r.state.now = T0 + 10 * MIN;
    await r.manual();
    assert.equal(r.reviews.retryAt(), T0 + RETRY_DELAY_MS);
  });

  it("is cancelled by a Review started by hand that succeeds", async () => {
    const r = await rig();
    r.state.answer = refused;
    await r.tick();
    assert.notEqual(r.reviews.retryAt(), null);
    r.state.now = T0 + 20 * MIN;
    r.state.answer = good;
    await r.manual();
    assert.equal(r.reviews.retryAt(), null);
    r.state.now = T0 + 2 * HOUR;
    await r.tick();
    assert.equal(r.reviews.list().length, 2);
  });

  it("survives a restart", async () => {
    const r = await rig();
    r.state.answer = refused;
    await r.tick();
    r.state.now = T0 + 30 * MIN;
    await r.restart();
    assert.equal(r.reviews.retryAt(), T0 + RETRY_DELAY_MS);
    r.state.now = T0 + HOUR;
    r.state.answer = good;
    await r.tick();
    assert.deepEqual(triggers(r), ["schedule:failed", "retry:done"]);
  });

  it("counts Reviews stored without a trigger as manual", async () => {
    const r = await rig();
    r.state.answer = refused;
    await r.manual();
    const stored = JSON.parse(JSON.stringify(r.reviews.list()[0]));
    delete stored.trigger;
    await writeFile(join(r.dir, "data", "reviews.json"), JSON.stringify({ version: 1, reviews: [stored] }));
    await r.restart();
    assert.equal(r.reviews.list()[0].trigger, "manual");
  });
});

describe("two failures in a row record one Event", () => {
  const fails = async (r: Awaited<ReturnType<typeof rig>>, n: number) => {
    r.state.answer = refused;
    for (let i = 0; i < n; i++) {
      r.state.now += HOUR;
      await r.manual();
    }
  };
  const kinds = (r: Awaited<ReturnType<typeof rig>>) => r.events.list().map((e) => e.kind);

  it("records nothing for the first failure, one Event for the second, and no more after that", async () => {
    const r = await rig();
    await fails(r, 1);
    assert.deepEqual(kinds(r), []);
    await fails(r, 1);
    assert.deepEqual(kinds(r), ["review_failed"]);
    const [event] = r.events.list();
    assert.deepEqual(event.review, { id: 2 });
    assert.equal(event.message, "Reviews are failing: The endpoint refused the key.");
    await fails(r, 4);
    assert.deepEqual(kinds(r), ["review_failed"]);
  });

  it("records another after a Review has been done", async () => {
    const r = await rig();
    await fails(r, 3);
    r.state.answer = good;
    r.state.now += HOUR;
    await r.manual();
    await fails(r, 1);
    assert.equal(kinds(r).length, 1);
    await fails(r, 1);
    assert.deepEqual(kinds(r), ["review_failed", "review_failed"]);
    assert.deepEqual(r.events.list().map((e) => e.review?.id), [6, 2]);
  });

  it("does not report again after a restart", async () => {
    const r = await rig();
    await fails(r, 2);
    await r.restart();
    await fails(r, 2);
    assert.equal(kinds(r).length, 1);
  });

  it("counts a retry as one of the failures", async () => {
    const r = await rig();
    r.state.answer = refused;
    await r.tick();
    r.state.now = T0 + HOUR;
    await r.tick();
    assert.deepEqual(kinds(r), ["review_failed"]);
  });

  it("sends an Alert that says Reviews are failing, with the reason and a link", async () => {
    const r = await rig({ publicUrl: "https://fairway.example.test/" });
    await fails(r, 2);
    await r.events.flush();
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0].event, "review_failed");
    assert.match(r.sent[0].message, /Reviews are failing: The endpoint refused the key\./);
    assert.equal(r.sent[0].link, "https://fairway.example.test/reviews?review=2");
    assert.equal(r.events.list()[0].delivery, "sent");
  });

  it("sends no Alert when its switch is off, but still records the Event", async () => {
    const r = await rig();
    r.events.configure({ policy: { ...DEFAULT_POLICY, triggers: { ...DEFAULT_POLICY.triggers, review_failed: false } } });
    await fails(r, 2);
    await r.events.flush();
    assert.equal(r.sent.length, 0);
    assert.equal(r.events.list().length, 1);
    assert.equal(DEFAULT_POLICY.triggers.review_failed, true);
  });

  it("is not recorded for a single failed Review that follows a done one", async () => {
    const r = await rig();
    r.state.now += HOUR;
    await r.manual();
    await fails(r, 1);
    assert.deepEqual(kinds(r), []);
  });
});

describe("the next successful Review covers what the failed ones missed", () => {
  it("starts where the last done Review ended", async () => {
    const r = await rig();
    await r.manual();
    const [first] = r.reviews.list();
    r.state.answer = refused;
    r.state.now = T0 + 6 * HOUR;
    await r.manual();
    r.state.now = T0 + 7 * HOUR;
    await r.manual();
    r.state.answer = good;
    r.state.now = T0 + 9 * HOUR;
    await r.manual();
    const [last] = r.reviews.list();
    assert.equal(last.status, "done");
    assert.deepEqual(last.period, { from: first.period.to, to: T0 + 9 * HOUR });
  });
});

describe("what retention keeps", () => {
  it("keeps the newest done Review however old, so the next period starts at its end", async () => {
    const r = await rig();
    await r.manual();
    const [done] = r.reviews.list();
    r.state.answer = refused;
    r.state.now = T0 + 20 * DAY;
    await r.manual();
    r.state.now = T0 + REVIEW_RETENTION_MS + 5 * DAY;
    await r.manual();
    assert.deepEqual(r.reviews.list().map((x) => x.id).sort(), [done.id, 2, 3]);
    r.state.answer = good;
    r.state.now = T0 + 31 * DAY;
    await r.manual();
    const [latest] = r.reviews.list();
    assert.equal(latest.status, "done");
    assert.deepEqual(latest.period, { from: done.period.to, to: T0 + 31 * DAY });
    assert.deepEqual(latest.coverage.gaps, []);
    r.state.now = T0 + 70 * DAY;
    await r.manual();
    assert.deepEqual(r.reviews.list()[0].coverage.gaps?.length, 1);
  });
});
