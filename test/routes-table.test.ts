import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collapse,
  destinationSummary,
  flattenSites,
  matcherChips,
  middlewareCount,
  parsePersisted,
  repeatFlags,
  sortKeys,
} from "../web/src/lib/routes-table.js";
import type { Site } from "../web/src/lib/api.js";

const proxy = (...upstreams: string[]) => ({ kind: "proxy" as const, summary: upstreams.join(", "), upstreams });
const sites: Site[] = [
  {
    hosts: ["a.test", "b.test"],
    listen: [":443"],
    middleware: [{ label: "encode" }],
    rules: [
      { match: "path /api/*", destinations: [proxy("10.0.0.1:80", "10.0.0.2:80"), { kind: "respond", summary: "200" }], middleware: [{ label: "cors" }] },
      { match: "", destinations: [proxy("10.0.0.3:80")], middleware: [] },
    ],
  },
  { hosts: ["c.test", "d.test"], listen: [":80"], middleware: [], rules: [] },
];

describe("flattenSites", () => {
  const rows = flattenSites(sites);
  it("gives one row per host and rule, and one per host without rules", () => {
    assert.equal(rows.length, 6);
    assert.deepEqual(rows.map((r) => r.host), ["a.test", "a.test", "b.test", "b.test", "c.test", "d.test"]);
    assert.equal(rows[4].rule, null);
    assert.equal(new Set(rows.map((r) => r.id)).size, 6);
  });
  it("flags repeated hosts", () => {
    assert.deepEqual(repeatFlags(rows.map((r) => r.host)), [false, true, false, true, false, false]);
  });
  it("counts site-wide and route middleware", () => {
    assert.deepEqual(rows.map(middlewareCount), [2, 1, 2, 1, 0, 0]);
  });
});

describe("chips and destinations", () => {
  it("collapses beyond two", () => {
    assert.deepEqual(collapse([1, 2, 3, 4]), { shown: [1, 2], more: 2 });
    assert.deepEqual(collapse([1]), { shown: [1], more: 0 });
  });
  it("falls back to the match text when matchers are missing", () => {
    const [row] = flattenSites(sites);
    assert.deepEqual(matcherChips(row.rule), [{ label: "path /api/*" }]);
    assert.deepEqual(matcherChips({ ...row.rule!, match: "" }), []);
    assert.deepEqual(matcherChips({ ...row.rule!, matchers: [{ label: "x", detail: "y" }] }), [{ label: "x", detail: "y" }]);
    assert.deepEqual(matcherChips(null), []);
  });
  it("shows the first destination and counts the rest", () => {
    const [row] = flattenSites(sites);
    const summary = destinationSummary(row.rule);
    assert.equal(summary.label, "10.0.0.1:80");
    assert.equal(summary.more, 2);
    assert.deepEqual(destinationSummary(null), { first: null, label: "", more: 0 });
  });
});

describe("sort keys", () => {
  it("sorts path by match, destination by summary and middleware by count", () => {
    const rows = flattenSites(sites);
    assert.equal(sortKeys.path(rows[0]), "path /api/*");
    assert.equal(sortKeys.path(rows[4]), "");
    assert.equal(sortKeys.destination(rows[1]), "10.0.0.3:80");
    assert.equal(sortKeys.middleware(rows[0]), 2);
    assert.equal(sortKeys.host(rows[2]), "b.test");
  });
});

describe("parsePersisted", () => {
  it("reads valid state", () => {
    const state = parsePersisted(JSON.stringify({ sorting: [{ id: "path", desc: true }], visibility: { path: false } }));
    assert.deepEqual(state, { sorting: [{ id: "path", desc: true }], visibility: { path: false } });
  });
  it("drops anything unexpected", () => {
    assert.deepEqual(parsePersisted(null), { sorting: [], visibility: {} });
    assert.deepEqual(parsePersisted("{nope"), { sorting: [], visibility: {} });
    assert.deepEqual(parsePersisted("42"), { sorting: [], visibility: {} });
    const state = parsePersisted(JSON.stringify({ sorting: [{ id: "bogus", desc: true }, { id: "host", desc: "x" }, { id: "activity", desc: false }, null], visibility: { host: "no", nope: true, path: false } }));
    assert.deepEqual(state, { sorting: [], visibility: { path: false } });
  });
});
