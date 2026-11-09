import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeLogFailure, formatDuration, formatLogRow, formatSize, statusTone } from "../web/src/lib/host-log-rows.js";
import type { HostLogLine } from "../web/src/lib/api.js";

const line = (over: Partial<HostLogLine> = {}): HostLogLine => ({
  time: new Date(2026, 0, 2, 3, 4, 5).getTime(),
  status: 200,
  method: "GET",
  host: "app.example.test",
  uri: "/a?b=1",
  client: "203.0.113.9",
  duration: 0.0123,
  size: 2048,
  userAgent: "",
  raw: {},
  ...over,
});

describe("formatLogRow", () => {
  it("formats a full line", () => {
    assert.deepEqual(formatLogRow(line()), {
      time: "03:04:05", status: "200", tone: "success", method: "GET", path: "/a?b=1",
      client: "203.0.113.9", duration: "12 ms", size: "2.0 kB",
    });
  });
  it("shows dashes for missing values", () => {
    const row = formatLogRow(line({ time: null, status: null, duration: null, size: null, client: "", method: "" }));
    assert.equal(row.time, "-");
    assert.equal(row.status, "-");
    assert.equal(row.tone, "none");
    assert.equal(row.client, "-");
    assert.equal(row.duration, "-");
    assert.equal(row.size, "-");
    assert.equal(row.method, "-");
  });
});

describe("units", () => {
  it("scales durations and sizes", () => {
    assert.equal(formatDuration(2.34), "2.3 s");
    assert.equal(formatDuration(30), "30 s");
    assert.equal(formatSize(12), "12 B");
    assert.equal(formatSize(3 * 1024 * 1024), "3.0 MB");
  });
  it("groups statuses", () => {
    assert.equal(statusTone(302), "redirect");
    assert.equal(statusTone(404), "client-error");
    assert.equal(statusTone(503), "server-error");
  });
});

describe("describeLogFailure", () => {
  it("names the expected file when missing", () => {
    const m = describeLogFailure({ ok: false, reason: "missing-file", file: "app.log", configuredPath: "/x/app.log" }, "app.example.test");
    assert.match(m.text, /app\.log/);
  });
  it("covers every reason", () => {
    const host = "app.example.test";
    assert.match(describeLogFailure({ ok: false, reason: "no-file-writer", output: "stderr" }, host).text, /stderr/);
    assert.match(describeLogFailure({ ok: false, reason: "missing-file", file: "a.log", configuredPath: "/x/a.log" }, host).text, /\/x\/a\.log/);
    assert.match(describeLogFailure({ ok: false, reason: "not-logged" }, host).text, /does not write access logs/);
    assert.equal(describeLogFailure({ ok: false, error: "Cannot reach Caddy" }, host).text, "Cannot reach Caddy");
  });
});
