import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterFromParams, rangeCovering } from "../web/src/lib/host-log-query.js";
import { REVIEW_LEVEL_OPTIONS, reviewLevelBody } from "../web/src/lib/alert-settings.js";
import { eventName, eventType, TYPE_LABELS } from "../web/src/lib/events-table.js";
import { buildUrl, parseParams } from "../web/src/lib/router.js";
import { findSite, logsParams, logsUrl } from "../web/src/lib/reviews.js";
import { siteNodeId } from "../web/src/lib/route-drawer.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2030, 0, 10, 12, 0, 0);
const site = { hosts: ["app.example.test", "www.example.test"], listen: [":443"] };

describe("the time range of a link", () => {
  it("is the smallest one that reaches the end of the period", () => {
    assert.equal(rangeCovering(NOW - 10 * 60_000, NOW), "1h");
    assert.equal(rangeCovering(NOW - HOUR, NOW), "1h");
    assert.equal(rangeCovering(NOW - 2 * HOUR, NOW), "24h");
    assert.equal(rangeCovering(NOW - 30 * HOUR, NOW), "7d");
    assert.equal(rangeCovering(NOW + HOUR, NOW), "1h");
  });

  it("is left out when even 7 days do not reach", () => {
    assert.equal(rangeCovering(NOW - 8 * 24 * HOUR, NOW), null);
  });
});

describe("a link from an Observation to the Logs tab", () => {
  const review = { period: { from: NOW - 25 * HOUR, to: NOW - 30 * 60_000 } };

  it("carries the Site's node, the Logs tab and the filters of the evidence", () => {
    const params = logsParams(site, review, NOW, { client: "203.0.113.9", path: "/admin", status: 401, count: 40, period: "last night" });
    assert.deepEqual(params, { node: "host:app.example.test,www.example.test|:443", tab: "logs", client: "203.0.113.9", path: "/admin", status: "4xx", range: "1h" });
    assert.equal(
      logsUrl(params),
      "/routes?node=host%3Aapp.example.test%2Cwww.example.test%7C%3A443&tab=logs&client=203.0.113.9&path=%2Fadmin&status=4xx&range=1h",
    );
  });

  it("sets only the range when there is no evidence, and drops what cannot be used", () => {
    assert.deepEqual(logsParams(site, review, NOW), { node: siteNodeId(site), tab: "logs", range: "1h" });
    const odd = logsParams(site, review, NOW, { path: "admin", status: 99, client: "  " });
    assert.deepEqual(odd, { node: siteNodeId(site), tab: "logs", range: "1h" });
    assert.equal(logsParams(site, { period: { from: 0, to: NOW - 9 * 24 * HOUR } }, NOW).range, undefined);
  });

  it("finds the Site by any of its hosts, ignoring case, and finds none for a Site that is gone", () => {
    assert.equal(findSite([site], "WWW.example.test"), site);
    assert.equal(findSite([site], "gone.example.test"), undefined);
  });

  it("is read back by the routes page, once validated", () => {
    const url = logsUrl(logsParams(site, review, NOW, { client: "203.0.113.9", path: "/admin", status: 503 }));
    const parsed = parseParams(url.slice(url.indexOf("?")), "routes");
    assert.deepEqual(filterFromParams(parsed), { classes: ["5xx"], path: "/admin", client: "203.0.113.9", range: "1h" });
    assert.equal(parsed.tab, "logs");
    assert.equal(parsed.node, siteNodeId(site));
  });
});

describe("the URL parameters of the Logs tab", () => {
  it("are owned by the routes page", () => {
    const search = "?node=host%3Aa%7C%3A443&tab=logs&client=1.2.3.4&path=%2Fx&status=4xx&range=24h";
    assert.equal(Object.keys(parseParams(search, "routes")).length, 6);
    for (const page of ["events", "history", "reviews", "editor", "logs"] as const) assert.deepEqual(parseParams(search, page), {});
    assert.equal(buildUrl("events", { tab: "logs", client: "1.2.3.4" }), "/events");
  });

  it("drop values that do not validate", () => {
    assert.deepEqual(parseParams("?tab=overview&status=6xx&range=30d&client=" + "9".repeat(101) + "&path=" + "p".repeat(501), "routes"), {});
    assert.deepEqual(parseParams("?status=abc&range=any", "routes"), {});
    assert.deepEqual(filterFromParams({}), { classes: [], path: "", client: "", range: "any" });
  });
});

describe("the Events tab", () => {
  const event = { kind: "review_found" as const, review: { id: 12 } };

  it("shows a Review Event as a one-shot occurrence of its own kind, named after its Review", () => {
    assert.equal(eventType(event), "review");
    assert.equal(TYPE_LABELS.review, "Review");
    assert.equal(eventName(event), "Review 12");
    assert.equal(eventName({ subject: "cert:a.example.test" }), "a.example.test");
  });
});

describe("the level setting in the interface", () => {
  it("offers info, notable, urgent and never, and sends one or a reset", () => {
    assert.deepEqual(REVIEW_LEVEL_OPTIONS.map((o) => o.value), ["info", "notable", "urgent", "never"]);
    assert.deepEqual(reviewLevelBody("never"), { reviewLevel: "never" });
    assert.deepEqual(reviewLevelBody(null), { reviewLevel: null });
  });
});
