import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaddyAdmin } from "../src/server/caddy-admin.js";
import { MetricsTracker, parseMetrics } from "../src/server/metrics.js";

const series = (host: string, code: string, count: number, seconds: number, bytes = 0, method = "GET") =>
  [
    `caddy_http_request_duration_seconds_count{code="${code}",handler="subroute",host="${host}",method="${method}",server="srv0"} ${count}`,
    `caddy_http_request_duration_seconds_sum{code="${code}",handler="subroute",host="${host}",method="${method}",server="srv0"} ${seconds}`,
    `caddy_http_response_size_bytes_sum{code="${code}",handler="subroute",host="${host}",method="${method}",server="srv0"} ${bytes}`,
  ].join("\n");

const tracker = () => new MetricsTracker({} as CaddyAdmin, 5000, 60);

test("parseMetrics sums over code, method and handler per host", () => {
  const text = [
    "# HELP caddy_http_request_duration_seconds Histogram",
    series("a.test", "200", 8, 0.8, 800),
    series("a.test", "404", 2, 0.2, 100),
    series("a.test", "200", 1, 0.1, 50, "POST"),
    series("b.test", "502", 3, 3, 0),
    'caddy_http_requests_in_flight{handler="subroute",host="a.test",server="srv0"} 2',
    'caddy_admin_http_requests_total{code="200",handler="metrics",method="GET",path="/metrics"} 99',
  ].join("\n");
  const hosts = parseMetrics(text);
  assert.equal(hosts.size, 2);
  const a = hosts.get("a.test")!;
  assert.equal(a.total, 11);
  assert.deepEqual(a.codes, { "2xx": 9, "3xx": 0, "4xx": 2, "5xx": 0, other: 0 });
  assert.equal(a.bytes, 950);
  assert.equal(a.inFlight, 2);
  assert.equal(hosts.get("b.test")!.codes["5xx"], 3);
});

test("series without a host label (per_host off) are ignored", () => {
  const text = 'caddy_http_request_duration_seconds_count{code="200",handler="subroute",method="GET",server="srv0"} 5';
  assert.equal(parseMetrics(text).size, 0);
});

const MIN = 60_000;
const at = (t: MetricsTracker, text: string, ms: number) => t.ingest(text, ms);
const stats = (t: MetricsTracker, windowMs: number, now: number, host = "a.test") => {
  const snap = t.snapshot(windowMs, now);
  assert.ok(snap.ok);
  return { snap, host: snap.hosts[host] };
};

test("the first sample is a baseline; later ones give window totals, rate, latency and history", () => {
  const t = tracker();
  at(t, series("a.test", "200", 100, 10), 0);
  at(t, series("a.test", "200", 110, 11), 5_000);
  at(t, series("a.test", "200", 130, 13), 10_000);
  const { host, snap } = stats(t, 5 * MIN, 10_000);
  assert.equal(host.requests, 30);
  assert.equal(host.codes["2xx"], 30);
  assert.equal(host.rate, 3); // 30 requests over the 10s watched so far
  assert.ok(Math.abs(host.avgMs - 100) < 1e-6); // 3s over 30 requests
  assert.equal(host.history.reduce((sum, n) => sum + n, 0), 30);
  assert.equal(snap.coveredMs, 10_000);
});

test("only requests inside the window count", () => {
  const t = tracker();
  at(t, series("a.test", "200", 0, 0), 0);
  at(t, series("a.test", "200", 10, 1), 1 * MIN);
  at(t, series("a.test", "200", 30, 3), 8 * MIN);
  assert.equal(stats(t, 5 * MIN, 8 * MIN).host.requests, 20);
  assert.equal(stats(t, 15 * MIN, 8 * MIN).host.requests, 30);
});

test("a counter that goes down is treated as a Caddy restart", () => {
  const t = tracker();
  at(t, series("a.test", "200", 500, 5), 0);
  at(t, series("a.test", "200", 7, 0.7), 5_000);
  assert.equal(stats(t, 5 * MIN, 5_000).host.requests, 7);
});

test("a host that appears later counts from zero", () => {
  const t = tracker();
  at(t, series("a.test", "200", 1, 0.1), 0);
  at(t, [series("a.test", "200", 1, 0.1), series("b.test", "200", 4, 0.4)].join("\n"), 5_000);
  assert.equal(stats(t, 5 * MIN, 5_000, "b.test").host.requests, 4);
  assert.equal(stats(t, 5 * MIN, 5_000, "a.test").host.requests, 0);
});

test("long windows read minute buckets, and old samples are dropped", () => {
  const t = tracker();
  // One request every 5 seconds for two hours.
  for (let i = 0; i <= 1440; i++) at(t, series("a.test", "200", i, 0), i * 5_000);
  const now = 1440 * 5_000;
  const hour = stats(t, 60 * MIN, now).host.requests;
  assert.ok(hour >= 718 && hour <= 722, `hour was ${hour}`);
  assert.equal(stats(t, 24 * 60 * MIN, now).host.requests, 1440);
  const internals = t as unknown as { samples: unknown[] };
  assert.ok(internals.samples.length <= 722, "fine samples are capped at about an hour");
});

test("history is binned across the window", () => {
  const t = tracker();
  at(t, series("a.test", "200", 0, 0), 0);
  at(t, series("a.test", "200", 5, 0), 4 * MIN + 59_000); // near the end of a 5 minute window
  const { host } = stats(t, 5 * MIN, 5 * MIN);
  assert.equal(host.history.length, 60);
  assert.equal(host.history[host.history.length - 1], 5);
});
