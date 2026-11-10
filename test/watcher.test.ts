import assert from "node:assert/strict";
import { test } from "node:test";
import { EventTracker } from "../src/server/events.js";
import { parseUpstreamHealth, Watcher, type WatcherSource } from "../src/server/watcher.js";

const T0 = Date.UTC(2026, 0, 1);

const gauge = (upstream: string, value: number) => `caddy_reverse_proxy_upstreams_healthy{upstream="${upstream}"} ${value}`;

test("health is read per upstream and the scheme is ignored", () => {
  const text = ["# HELP caddy_reverse_proxy_upstreams_healthy x", gauge("app:3000", 1), gauge("https://db:5432", 0), 'caddy_http_requests_total{host="a"} 3'].join("\n");
  assert.deepEqual(parseUpstreamHealth(text), { "upstream:app:3000": true, "upstream:db:5432": false });
  assert.deepEqual(parseUpstreamHealth(""), {});
});

function rig(initial: { up: boolean; text: string | null }) {
  const state = { ...initial };
  const source: WatcherSource = { ping: async () => state.up, metricsText: async () => state.text };
  const events = new EventTracker();
  return { state, events, watcher: new Watcher(events, source) };
}

test("an upstream that stays unhealthy becomes down, then recovers", async () => {
  const { state, events, watcher } = rig({ up: true, text: gauge("app:3000", 1) });
  await watcher.tick(T0);
  state.text = gauge("app:3000", 0);
  await watcher.tick(T0 + 5_000);
  assert.equal(events.stateOf("upstream:app:3000"), "ok");
  await watcher.tick(T0 + 70_000);
  assert.equal(events.stateOf("upstream:app:3000"), "down");
  state.text = gauge("app:3000", 1);
  await watcher.tick(T0 + 75_000);
  await watcher.tick(T0 + 140_000);
  assert.equal(events.stateOf("upstream:app:3000"), "ok");
});

test("Caddy not answering becomes down and leaves upstream States alone", async () => {
  const { state, events, watcher } = rig({ up: true, text: gauge("app:3000", 1) });
  await watcher.tick(T0);
  state.up = false;
  for (let t = 5_000; t <= 25_000; t += 5_000) await watcher.tick(T0 + t);
  assert.equal(events.stateOf("caddy"), "down");
  assert.equal(events.stateOf("upstream:app:3000"), "ok");
});

test("an upstream whose health check was removed stops being a Subject; unreadable metrics change nothing", async () => {
  const { state, events, watcher } = rig({ up: true, text: gauge("app:3000", 1) });
  await watcher.tick(T0);
  state.text = null;
  await watcher.tick(T0 + 5_000);
  assert.equal(events.stateOf("upstream:app:3000"), "ok");
  state.text = "";
  await watcher.tick(T0 + 10_000);
  assert.equal(events.stateOf("upstream:app:3000"), null);
});
