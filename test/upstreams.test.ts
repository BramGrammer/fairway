import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUpstreams } from "../src/server/upstreams.js";

test("parseUpstreams maps address to failure and request counts", () => {
  const parsed = parseUpstreams(
    JSON.stringify([
      { address: "app:8080", num_requests: 2, fails: 0 },
      { address: "db:5432", num_requests: 0, fails: 3 },
    ]),
  );
  assert.deepEqual(parsed, {
    "app:8080": { fails: 0, requests: 2 },
    "db:5432": { fails: 3, requests: 0 },
  });
});

test("parseUpstreams treats null and an empty list as no upstreams", () => {
  assert.deepEqual(parseUpstreams("null"), {});
  assert.deepEqual(parseUpstreams("[]"), {});
});

test("parseUpstreams skips malformed entries and rejects non-lists", () => {
  assert.deepEqual(parseUpstreams(JSON.stringify([{ nope: 1 }, { address: "a:1" }])), { "a:1": { fails: 0, requests: 0 } });
  assert.throws(() => parseUpstreams('{"a":1}'));
});
