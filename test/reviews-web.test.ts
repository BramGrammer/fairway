import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countByLevel, evidenceLine, groupByLevel, parsePersistedReviews, nextReviewLabel, reviewFixPrompt, reviewsAvailable, totalTokens, type Observation, type Review, type ReviewSchedule } from "../web/src/lib/reviews.js";

const observation = (level: Observation["level"], title = "t"): Observation => ({ level, sites: ["a.example.test"], title, explanation: "e", evidence: [] });

describe("Observations by level", () => {
  const list = [observation("info", "a"), observation("urgent", "b"), observation("info", "c")];

  it("counts per level", () => {
    assert.deepEqual(countByLevel(list), { urgent: 1, notable: 0, info: 2 });
    assert.deepEqual(countByLevel([]), { urgent: 0, notable: 0, info: 0 });
  });

  it("groups the most urgent first and leaves empty levels out", () => {
    assert.deepEqual(groupByLevel(list).map((g) => [g.level, g.observations.map((o) => o.title)]), [["urgent", ["b"]], ["info", ["a", "c"]]]);
  });
});

describe("evidence and usage", () => {
  it("writes evidence as one plain line", () => {
    assert.equal(evidenceLine({ client: "203.0.113.9", path: "/.env", status: 404, count: 1 }), "203.0.113.9 · /.env · 404 · 1 request");
    assert.equal(evidenceLine({ count: 5, period: "10:00 to 11:00" }), "5 requests · 10:00 to 11:00");
  });

  it("adds tokens, and has none when the endpoint reported none", () => {
    assert.equal(totalTokens({ promptTokens: 1200, completionTokens: 80 }), 1280);
    assert.equal(totalTokens(null), null);
  });
});

describe("whether Reviews are offered", () => {
  it("needs the Reviews model and a login", () => {
    assert.equal(reviewsAvailable(true, true), true);
    assert.equal(reviewsAvailable(true, false), false);
    assert.equal(reviewsAvailable(false, true), false);
    assert.equal(reviewsAvailable(undefined, true), false);
  });
});

describe("the stored table state", () => {
  it("keeps known columns and drops the rest", () => {
    assert.deepEqual(parsePersistedReviews(JSON.stringify({ sorting: [{ id: "tokens", desc: true }, { id: "nope", desc: true }], visibility: { status: false, nope: false } })), { sorting: [{ id: "tokens", desc: true }], visibility: { status: false } });
    assert.deepEqual(parsePersistedReviews("not json"), { sorting: [], visibility: {} });
  });
});

describe("when the next Review is due", () => {
  const at = Date.UTC(2030, 0, 1);
  const schedule = (nextAt: number | null, extra: Partial<ReviewSchedule> = {}): ReviewSchedule => ({ interval: "24h", active: nextAt !== null, idleReason: null, nextAt, ...extra });

  it("says in about how many hours", () => {
    assert.equal(nextReviewLabel(schedule(at + 5 * 3_600_000), at), "Next Review in about 5 hours");
    assert.equal(nextReviewLabel(schedule(at + 20 * 60_000), at), "Next Review in about 20 minutes");
    assert.equal(nextReviewLabel(schedule(at - 1000), at), "Next Review is due now");
  });

  it("says when the schedule is off or idle", () => {
    assert.equal(nextReviewLabel(schedule(null, { interval: "off" }), at), "Scheduled Reviews are off");
    assert.equal(nextReviewLabel(schedule(null, { idleReason: "Choose a model." }), at), "Scheduled Reviews are idle: Choose a model.");
  });
});

describe("asking the Assistant to fix what a Review found", () => {
  const review = (overrides: Partial<Review> = {}): Review => ({
    id: 1, startedAt: 0, finishedAt: 1, period: { from: 0, to: 3_600_000 }, status: "done", failure: null, summary: "s",
    observations: [observation("info", "quiet"), { ...observation("urgent", "Scanner"), explanation: "Probing\n  for /.env", evidence: [{ client: "203.0.113.9", path: "/.env", status: 404, count: 9 }, { path: "/a" }, { path: "/b" }, { path: "/c" }] }],
    coverage: { sites: [], skipped: [] }, model: "m", usage: null, ...overrides,
  });

  it("lists what was found, the most urgent first, with a little evidence, and asks for a Proposal", () => {
    const text = reviewFixPrompt(review())!;
    assert.match(text, /^A Review of the access logs from .* found the following\. Propose changes to the Caddyfile/);
    assert.ok(text.indexOf("Urgent: Scanner (a.example.test)") < text.indexOf("Info: quiet"));
    assert.match(text, /Probing for \/\.env/);
    assert.match(text, /203\.0\.113\.9 · \/\.env · 404 · 9 requests/);
    assert.equal(text.includes("/c"), false, "only the first three evidence lines go along");
  });

  it("has nothing to ask about a Review that is not done or found nothing, and stays within a size", () => {
    assert.equal(reviewFixPrompt(review({ status: "failed", observations: [] })), null);
    assert.equal(reviewFixPrompt(review({ observations: [] })), null);
    const many = Array.from({ length: 200 }, (_, i) => observation("notable", `finding ${i}`));
    assert.ok(reviewFixPrompt(review({ observations: many }))!.length <= 6000);
  });
});
