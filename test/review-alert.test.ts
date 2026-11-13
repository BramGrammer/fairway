import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { REVIEW_LEVELS } from "../src/server/alert-policy.js";
import { AlertSettings } from "../src/server/alert-settings.js";
import { ntfyLook, type AlertPayload, type AlertSender } from "../src/server/alerts.js";
import { EventTracker } from "../src/server/events.js";
import { alertOnFinished, plainText, reviewFound, reviewFoundMessage, reviewLink } from "../src/server/review-alert.js";
import { REPORT_TOOL, type Observation } from "../src/server/review-result.js";
import { Reviews } from "../src/server/reviews.js";

const obs = (level: Observation["level"], title: string, sites = ["app.example.test"], ongoing?: boolean): Observation => ({
  level,
  sites,
  title,
  explanation: "x",
  evidence: [],
  ...(ongoing !== undefined && { ongoing }),
});

describe("when a Review is worth an Alert", () => {
  const review = { id: 7, observations: [obs("info", "Background noise"), obs("notable", "Odd methods", ["b.example.test"]), obs("urgent", "Admin page reached", ["app.example.test", "b.example.test"])] };

  it("counts the Observations at or above each level", () => {
    assert.equal(reviewFound(review, "info")?.count, 3);
    assert.equal(reviewFound(review, "notable")?.count, 2);
    assert.equal(reviewFound(review, "urgent")?.count, 1);
    assert.equal(reviewFound(review, "never"), null);
    assert.deepEqual(REVIEW_LEVELS, ["info", "notable", "urgent", "never"]);
  });

  it("names the highest level, the Sites involved and the most serious title", () => {
    assert.deepEqual(reviewFound(review, "notable"), { reviewId: 7, level: "urgent", count: 2, sites: ["b.example.test", "app.example.test"], title: "Admin page reached" });
  });

  it("is nothing when no Observation reaches the level", () => {
    assert.equal(reviewFound({ id: 1, observations: [obs("info", "a"), obs("notable", "b")] }, "urgent"), null);
    assert.equal(reviewFound({ id: 1, observations: [] }, "info"), null);
  });

  it("does not count an ongoing Observation", () => {
    assert.equal(reviewFound({ id: 1, observations: [obs("urgent", "Still going", ["a.example.test"], true)] }, "info"), null);
    const mixed = reviewFound({ id: 1, observations: [obs("urgent", "Still going", ["a.example.test"], true), obs("notable", "New", ["b.example.test"], false)] }, "info");
    assert.deepEqual([mixed?.count, mixed?.level, mixed?.title, mixed?.sites], [1, "notable", "New", ["b.example.test"]]);
  });

  it("keeps the model's order among equally serious Observations", () => {
    assert.equal(reviewFound({ id: 1, observations: [obs("urgent", "First"), obs("urgent", "Second")] }, "urgent")?.title, "First");
  });
});

describe("text from the model", () => {
  it("becomes one plain line, cut to length", () => {
    assert.equal(plainText("a\r\nb\tc\u0000d e‮f", 50), "a b c d e f");
    assert.equal(plainText("x".repeat(300), 20), `${"x".repeat(17)}...`);
    assert.equal(plainText(42, 20), "");
  });

  it("is cleaned in the Event's data and in the message", () => {
    const found = reviewFound({ id: 3, observations: [obs("urgent", `Bad\n\u0007title ${"y".repeat(400)}`, ["evil.example.test\nInjected: header"])] }, "urgent")!;
    assert.doesNotMatch(found.title, /[\n\u0007]/);
    assert.ok(found.title.length <= 120);
    assert.deepEqual(found.sites, ["evil.example.test Injected: header"]);
    assert.doesNotMatch(reviewFoundMessage(found), /[\n\r]/);
  });

  it("names a few Sites and counts the rest", () => {
    const message = reviewFoundMessage({ level: "urgent", count: 5, sites: ["a.test", "b.test", "c.test", "d.test", "e.test"], title: "Probing" });
    assert.equal(message, "Review found something on a.test, b.test, c.test and 2 more (urgent, 5 observations): Probing");
    assert.match(reviewFoundMessage({ level: "info", count: 1, sites: [], title: "T" }), /^Review found something \(info, 1 observation\): T$/);
  });
});

describe("the Event and its Alert", () => {
  const found = { reviewId: 12, level: "urgent" as const, count: 2, sites: ["app.example.test"], title: "Admin page reached" };
  const rig = (publicUrl: string | null, withSender = true) => {
    const sent: AlertPayload[] = [];
    const sender: AlertSender = { async send(payload) { sent.push(payload); } };
    const events = new EventTracker({ ...(withSender && { sender }), publicUrl });
    return { sent, events };
  };

  it("records one one-shot Event with the Review's data and sends one Alert that links to the Review", async () => {
    const { sent, events } = rig("https://fairway.example.test/");
    events.recordReviewFound(found, 1_000);
    await events.flush();
    const [event] = events.list();
    assert.equal(event.kind, "review_found");
    assert.equal(event.subject, undefined);
    assert.equal(event.state, undefined);
    assert.deepEqual(event.review, { id: 12, level: "urgent", count: 2, sites: ["app.example.test"], title: "Admin page reached" });
    assert.equal(event.delivery, "sent");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].event, "review_found");
    assert.equal(sent[0].link, "https://fairway.example.test/reviews?review=12");
    assert.match(sent[0].message, /app\.example\.test/);
    assert.match(sent[0].message, /Admin page reached/);
    assert.equal(ntfyLook(sent[0]).priority, "high");
    assert.equal(ntfyLook({ ...sent[0], level: "notable" }).priority, "default");
  });

  it("has no link without a public address, and is recorded without ntfy", () => {
    const withoutUrl = rig(null);
    withoutUrl.events.recordReviewFound(found);
    assert.equal(withoutUrl.events.list().length, 1);
    const bare = rig("https://fairway.example.test", false);
    bare.events.recordReviewFound(found);
    assert.equal(bare.events.list()[0].delivery, undefined);
    assert.equal(reviewLink("https://f.example.test///", 3), "https://f.example.test/reviews?review=3");
  });

  it("survives a save and a load", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ev-")), "events.json");
    const a = new EventTracker({ file });
    a.recordReviewFound(found, 5_000);
    await a.save();
    const b = new EventTracker({ file });
    await b.load();
    assert.equal(b.list()[0].review?.id, 12);
  });
});

describe("the level setting", () => {
  it("is urgent until the Owner changes it, and can be reset", async () => {
    const s = new AlertSettings({ ntfyUrls: [], ntfyToken: null, publicUrl: null });
    assert.deepEqual(s.view(false).reviewLevel, { value: "urgent", default: "urgent", overridden: false });
    assert.equal((await s.patch({ reviewLevel: "never" })).ok, true);
    assert.equal(s.effective().policy.reviewLevel, "never");
    assert.equal(s.view(false).reviewLevel.overridden, true);
    assert.equal((await s.patch({ reviewLevel: null })).ok, true);
    assert.equal(s.effective().policy.reviewLevel, "urgent");
  });

  it("refuses a level that does not exist", async () => {
    const s = new AlertSettings({ ntfyUrls: [], ntfyToken: null, publicUrl: null });
    assert.equal((await s.patch({ reviewLevel: "loud" as never })).ok, false);
    assert.equal(s.effective().policy.reviewLevel, "urgent");
  });

  it("is kept with the other alert settings", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "as-")), "alert-settings.json");
    const a = new AlertSettings({ ntfyUrls: [], ntfyToken: null, publicUrl: null }, file);
    await a.patch({ reviewLevel: "notable" });
    const b = new AlertSettings({ ntfyUrls: [], ntfyToken: null, publicUrl: null }, file);
    await b.load();
    assert.equal(b.effective().policy.reviewLevel, "notable");
  });
});

describe("a Review that finishes", () => {
  const HOUR = 3_600_000;
  const T0 = Date.UTC(2030, 0, 1);
  const logging = { logs: { web: { writer: { output: "file", filename: "/var/log/caddy/web.log" } } } };
  const servers = {
    srv0: {
      listen: [":443"],
      logs: { logger_names: { "app.example.test": ["web"] } },
      routes: [{ match: [{ host: ["app.example.test"] }], handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "10.9.8.7:4000" }] }] }],
    },
  };
  const line = JSON.stringify({ level: "info", ts: (T0 + 600_000) / 1000, logger: "http.log.access", msg: "handled request", request: { remote_ip: "203.0.113.9", method: "GET", host: "app.example.test", uri: "/.env", headers: {} }, status: 404, duration: 0.01, size: 1 });
  const sse = (args: unknown) =>
    new Response([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: REPORT_TOOL, arguments: JSON.stringify(args) } }] } }] }, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

  async function finish(observations: Observation[], level: Parameters<typeof reviewFound>[1], options: { fail?: boolean } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "ra-"));
    await writeFile(join(dir, "web.log"), `${line}\n`);
    const events = new EventTracker();
    const reviews = new Reviews({
      file: join(dir, "data", "reviews.json"),
      settings: { model: () => "made-up-model", effective: () => ({ baseUrl: "http://llm.example.test/v1", apiKey: null }) },
      loadLive: async () => (options.fail ? { ok: false, error: "no caddy" } : { ok: true, logging, servers }),
      logDir: dir,
      loginRequired: true,
      fetchImpl: (async () => sse({ summary: "s", observations })) as unknown as typeof fetch,
      now: () => T0 + 24 * HOUR,
      onFinished: alertOnFinished({ level: () => level, record: (found) => events.recordReviewFound(found), recordFailing: (failing) => events.recordReviewFailing(failing) }),
    });
    await reviews.load();
    await reviews.start();
    await reviews.idle();
    return { events, reviews };
  }

  it("records exactly one Event however many Observations qualify", async () => {
    const { events, reviews } = await finish([obs("urgent", "One"), obs("urgent", "Two"), obs("notable", "Three")], "notable");
    assert.equal(reviews.list()[0].status, "done");
    assert.equal(events.list().length, 1);
    assert.deepEqual([events.list()[0].review?.id, events.list()[0].review?.count, events.list()[0].review?.title], [reviews.list()[0].id, 3, "One"]);
  });

  it("records nothing below the level, with never, for ongoing Observations, or when the Review failed", async () => {
    assert.equal((await finish([obs("notable", "n")], "urgent")).events.list().length, 0);
    assert.equal((await finish([obs("urgent", "u")], "never")).events.list().length, 0);
    assert.equal((await finish([obs("urgent", "u", ["app.example.test"], true)], "info")).events.list().length, 0);
    const failed = await finish([obs("urgent", "u")], "info", { fail: true });
    assert.equal(failed.reviews.list()[0].status, "failed");
    assert.equal(failed.events.list().length, 0);
  });

  it("is not undone by a follow-up that throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra-"));
    await writeFile(join(dir, "web.log"), `${line}\n`);
    const reviews = new Reviews({
      file: join(dir, "reviews.json"),
      settings: { model: () => "m", effective: () => ({ baseUrl: "http://llm.example.test/v1", apiKey: null }) },
      loadLive: async () => ({ ok: true, logging, servers }),
      logDir: dir,
      loginRequired: true,
      fetchImpl: (async () => sse({ summary: "s", observations: [] })) as unknown as typeof fetch,
      now: () => T0 + 24 * HOUR,
      onFinished: () => {
        throw new Error("boom");
      },
    });
    await reviews.start();
    await reviews.idle();
    assert.equal(reviews.list()[0].status, "done");
  });
});
