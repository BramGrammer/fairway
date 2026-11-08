import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAge } from "../web/src/lib/age.js";

test("formatAge gives a short relative age", () => {
  const now = 1_000_000_000;
  assert.equal(formatAge(now - 5_000, now), "just now");
  assert.equal(formatAge(now - 5 * 60_000, now), "5 min ago");
  assert.equal(formatAge(now - 3 * 3_600_000, now), "3 h ago");
  assert.equal(formatAge(now - 2 * 86_400_000, now), "2 days ago");
  assert.equal(formatAge(now - 1 * 86_400_000, now), "1 day ago");
  assert.equal(formatAge(now + 60_000, now), "just now");
});
