import assert from "node:assert/strict";
import { test } from "node:test";
import { codeSplit, estimateTraffic, mergeStats, trafficContributions } from "../web/src/lib/traffic.js";

const stats = (requests: number, over: Record<string, unknown> = {}) => ({
  requests,
  codes: { "2xx": requests, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 },
  bytes: 0,
  avgMs: 10,
  inFlight: 2,
  rate: 4,
  history: [1, 2, 3],
  ...over,
});

test("mergeStats sums counts and weights latency by requests", () => {
  assert.equal(mergeStats([]), null);
  const merged = mergeStats([stats(10, { avgMs: 10 }), stats(30, { avgMs: 30 })])!;
  assert.equal(merged.requests, 40);
  assert.equal(merged.avgMs, 25);
  assert.deepEqual(merged.history, [2, 4, 6]);
  assert.equal(merged.inFlight, 4);
});

test("codeSplit gives fractions of the total", () => {
  const split = codeSplit(stats(100, { codes: { "2xx": 80, "3xx": 10, "4xx": 5, "5xx": 5, other: 0 } }));
  assert.deepEqual(split.map((s) => [s.key, s.share]), [["2xx", 0.8], ["3xx", 0.1], ["4xx", 0.05], ["5xx", 0.05]]);
  assert.deepEqual(codeSplit(stats(0)).map((s) => s.share), [0, 0, 0, 0]);
});

test("trafficContributions: a host takes all of its own traffic", () => {
  const paths = [{ host: "h1" }, { host: "h1" }, { host: "h2" }];
  assert.deepEqual(trafficContributions(paths, () => true, true), [
    { host: "h1", fraction: 1 },
    { host: "h2", fraction: 1 },
  ]);
});

test("trafficContributions: a rule or destination takes its share of paths per host", () => {
  const paths = [
    { host: "h1", id: "a" },
    { host: "h1", id: "b" },
    { host: "h2", id: "a" },
  ];
  assert.deepEqual(trafficContributions(paths, (p) => p.id === "a", false), [
    { host: "h1", fraction: 0.5 },
    { host: "h2", fraction: 1 },
  ]);
});

test("estimateTraffic scales stats and reports share of the contributing sites", () => {
  const est = estimateTraffic([
    { stats: stats(100), fraction: 0.5 },
    { stats: stats(100), fraction: 1 },
    { stats: null, fraction: 1 },
  ])!;
  assert.equal(est.stats.requests, 150);
  assert.equal(est.stats.rate, 6);
  assert.deepEqual(est.stats.history, [1.5, 3, 4.5]);
  assert.equal(est.share, 0.75);
  assert.equal(estimateTraffic([{ stats: null, fraction: 1 }]), null);
});
