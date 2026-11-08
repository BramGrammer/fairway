import assert from "node:assert/strict";
import { test } from "node:test";
import { upstreamHealth, worstHealth, type UpstreamsReply } from "../web/src/lib/upstream-health.js";

const reply: UpstreamsReply = {
  ok: true,
  upstreams: { "app:8080": { fails: 0, requests: 1 }, "db:5432": { fails: 2, requests: 0 } },
};

test("an upstream with no failures is healthy, with failures down", () => {
  assert.deepEqual(upstreamHealth("app:8080", reply), { health: "healthy", fails: 0 });
  assert.deepEqual(upstreamHealth("db:5432", reply), { health: "down", fails: 2 });
});

test("a TLS prefix is ignored when looking up the address", () => {
  assert.equal(upstreamHealth("https://app:8080", reply)?.health, "healthy");
});

test("no health when Caddy cannot report or does not know the upstream", () => {
  assert.equal(upstreamHealth("app:8080", null), null);
  assert.equal(upstreamHealth("app:8080", { ok: false, error: "x" }), null);
  assert.equal(upstreamHealth("other:1", reply), null);
});

test("worstHealth takes the worst known state and ignores unknown", () => {
  const up = { health: "healthy", fails: 0 } as const;
  const down = { health: "down", fails: 1 } as const;
  assert.equal(worstHealth([up, down, null]), "down");
  assert.equal(worstHealth([up, null]), "healthy");
  assert.equal(worstHealth([null]), null);
  assert.equal(worstHealth([]), null);
});
