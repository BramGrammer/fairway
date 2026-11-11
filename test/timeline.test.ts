import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatSpan,
  outageCount,
  segmentLabel,
  summarize,
  toSegments,
  type TimelineInterval,
} from "../web/src/lib/timeline.js";

const H = 3_600_000;

test("intervals become segments whose widths add up to the window", () => {
  const intervals: TimelineInterval[] = [
    { from: 0, to: H, state: "ok" },
    { from: H, to: 2 * H, state: "down" },
    { from: 2 * H, to: 4 * H, state: "ok" },
  ];
  const segments = toSegments(intervals, 0, 4 * H);
  assert.deepEqual(segments.map((s) => s.widthPct), [25, 25, 50]);
});

test("neighbours with the same state merge and empty intervals vanish", () => {
  const segments = toSegments(
    [
      { from: 0, to: H, state: "ok" },
      { from: H, to: H, state: "down" },
      { from: H, to: 2 * H, state: "ok" },
    ],
    0,
    2 * H,
  );
  assert.equal(segments.length, 1);
  assert.equal(segments[0].widthPct, 100);
});

test("intervals are clamped to the window", () => {
  const segments = toSegments([{ from: -H, to: 5 * H, state: "ok" }], 0, 2 * H);
  assert.deepEqual(segments.map((s) => [s.from, s.to, s.widthPct]), [[0, 2 * H, 100]]);
});

test("a zero-length window gives no segments", () => {
  assert.deepEqual(toSegments([{ from: 0, to: 1, state: "ok" }], 5, 5), []);
});

test("outages are counted per stretch and summarised", () => {
  const segments = toSegments(
    [
      { from: 0, to: H, state: "down" },
      { from: H, to: 2 * H, state: "ok" },
      { from: 2 * H, to: 3 * H, state: "down" },
      { from: 3 * H, to: 24 * H, state: "warning" },
    ],
    0,
    24 * H,
  );
  assert.equal(outageCount(segments), 2);
  assert.equal(summarize(segments, 24 * H), "2 outages in 24 h");
  assert.equal(summarize(segments.slice(1, 2), 24 * H), "No outages in 24 h");
});

test("a single outage is singular, all unknown means no data", () => {
  assert.equal(summarize(toSegments([{ from: 0, to: H, state: "down" }], 0, H), 24 * H), "1 outage in 24 h");
  assert.equal(summarize(toSegments([{ from: 0, to: H, state: "unknown" }], 0, H), 24 * H), "No data yet");
});

test("spans and labels read plainly", () => {
  assert.equal(formatSpan(30_000), "30s");
  assert.equal(formatSpan(45 * 60_000), "45m");
  assert.equal(formatSpan(3 * H + 20 * 60_000), "3h 20m");
  assert.equal(formatSpan(2 * H), "2h");
  assert.match(segmentLabel({ state: "unknown", from: 0, to: H }), /^Not watching, .* \(1h\)$/);
  assert.match(segmentLabel({ state: "down", from: 0, to: 1800_000 }), /^Down, .* \(30m\)$/);
});
