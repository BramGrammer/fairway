import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_ROWS_PER_CALL, MAX_ROWS_PER_CALL, MAX_ROWS_PER_REVIEW, parseLinesCall, runLinesCall } from "../src/server/review-lines.js";

const MIN = 60_000;
const T0 = Date.UTC(2030, 0, 1, 0, 0, 0);
const period = { from: T0, to: T0 + 24 * 60 * MIN };
const hosts = ["app.example.test"];

const entry = (at: number, status: number, uri: string, client: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ level: "info", ts: at / 1000, logger: "http.log.access", msg: "handled request", request: { remote_ip: client, method: "GET", host: "app.example.test", uri, headers: { "User-Agent": ["scanner/1"], Authorization: ["Bearer made-up"], Cookie: ["sid=made-up"] }, ...extra }, status, duration: 0.01, size: 12 });

const logging = { logs: { web: { writer: { output: "file", filename: "/var/log/caddy/web.log" } } } };
const servers = { srv0: { listen: [":443"], logs: { logger_names: { "app.example.test": ["web"] } }, routes: [] } };

async function source(lines: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "ce-lines-"));
  await writeFile(join(dir, "web.log"), lines.join("\n") + "\n");
  return { logging, servers, logDir: dir };
}

describe("checking the arguments", () => {
  const parse = (args: unknown) => parseLinesCall(JSON.stringify(args), period, hosts);

  it("requires a host of a Site in the Review", () => {
    assert.equal(parse({}).ok, false);
    const refused = parse({ host: "elsewhere.example.test" });
    assert.ok(!refused.ok && /not a host/.test(refused.error));
    assert.ok(parse({ host: "APP.example.test:443" }).ok);
  });

  it("rejects unknown arguments, bad JSON and bad values", () => {
    assert.equal(parse({ host: hosts[0], raw: true }).ok, false);
    assert.equal(parseLinesCall("{nope", period, hosts).ok, false);
    assert.equal(parse({ host: hosts[0], status: [99] }).ok, false);
    assert.equal(parse({ host: hosts[0], status: ["abc"] }).ok, false);
    assert.equal(parse({ host: hosts[0], path_prefix: "admin" }).ok, false);
    assert.equal(parse({ host: hosts[0], path_prefix: "/a?x=1" }).ok, false);
    assert.equal(parse({ host: hosts[0], limit: 0 }).ok, false);
    assert.equal(parse({ host: hosts[0], from: "yesterday" }).ok, false);
  });

  it("clamps the time range to the period and refuses one outside it", () => {
    const wide = parse({ host: hosts[0], from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" });
    assert.ok(wide.ok);
    assert.deepEqual([wide.request.from, wide.request.to], [period.from, period.to]);
    const before = parse({ host: hosts[0], from: "2000-01-01T00:00:00Z", to: "2000-01-02T00:00:00Z" });
    assert.ok(!before.ok && /outside the period/.test(before.error));
    assert.equal(parse({ host: hosts[0], from: "2100-01-01T00:00:00Z" }).ok, false);
  });

  it("caps the limit", () => {
    const parsed = parse({ host: hosts[0], limit: 5000 });
    assert.ok(parsed.ok);
    assert.equal(parsed.request.limit, MAX_ROWS_PER_CALL);
  });
});

describe("running a call", () => {
  it("returns only the named fields, newest first, with the query string removed", async () => {
    const src = await source([entry(T0 + MIN, 404, "/.env?token=secret#frag", "203.0.113.9"), entry(T0 + 2 * MIN, 200, "/", "198.51.100.1")]);
    const answer = await runLinesCall(JSON.stringify({ host: hosts[0], view: "rows" }), src, period, hosts);
    const result = JSON.parse(answer.content);
    assert.equal(result.more, false);
    assert.equal(answer.rows, 2);
    assert.deepEqual(result.rows[1], { time: new Date(T0 + MIN).toISOString().slice(0, 19) + "Z", status: 404, method: "GET", path: "/.env", client: "203.0.113.9", size: 12, userAgent: "scanner/1" });
    assert.deepEqual(Object.keys(result.rows[0]).sort(), ["client", "method", "path", "size", "status", "time", "userAgent"]);
    assert.equal(result.rows[0].path, "/");
    for (const leak of ["secret", "made-up", "Authorization", "Cookie", "handled request"]) assert.ok(!answer.content.includes(leak), leak);
  });

  it("truncates a long user agent", async () => {
    const src = await source([entry(T0 + MIN, 200, "/", "203.0.113.9").replace("scanner/1", "x".repeat(500))]);
    const result = JSON.parse((await runLinesCall(JSON.stringify({ host: hosts[0], view: "rows" }), src, period, hosts)).content);
    assert.equal(result.rows[0].userAgent.length, 60);
  });

  it("filters on status, path prefix and client", async () => {
    const src = await source([entry(T0 + MIN, 404, "/admin/x", "203.0.113.9"), entry(T0 + 2 * MIN, 200, "/admin/y", "203.0.113.9"), entry(T0 + 3 * MIN, 404, "/admin/z", "198.51.100.1"), entry(T0 + 4 * MIN, 404, "/other", "203.0.113.9")]);
    const answer = await runLinesCall(JSON.stringify({ host: hosts[0], view: "rows", status: ["4xx"], path_prefix: "/admin", client: "203.0.113.9" }), src, period, hosts);
    assert.deepEqual(JSON.parse(answer.content).rows.map((r: any) => r.path), ["/admin/x"]);
  });

  it("returns at most the row cap and says there were more", async () => {
    const lines = Array.from({ length: MAX_ROWS_PER_CALL + 5 }, (_, i) => entry(T0 + (i + 1) * MIN / 10, 200, `/p${i}`, "203.0.113.9"));
    const src = await source(lines);
    const answer = await runLinesCall(JSON.stringify({ host: hosts[0], view: "rows", limit: 9999 }), src, period, hosts);
    const result = JSON.parse(answer.content);
    assert.equal(result.rows.length, MAX_ROWS_PER_CALL);
    assert.equal(result.more, true);
    assert.equal(result.rows[0].path, `/p${MAX_ROWS_PER_CALL + 4}`);
    assert.equal(answer.request?.limit, MAX_ROWS_PER_CALL);
  });

  it("reads only lines inside the period", async () => {
    const src = await source([entry(T0 - 5 * MIN, 200, "/before", "203.0.113.9"), entry(T0 + MIN, 200, "/inside", "203.0.113.9"), entry(period.to + 5 * MIN, 200, "/after", "203.0.113.9")]);
    const answer = await runLinesCall(JSON.stringify({ host: hosts[0], view: "rows", from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" }), src, period, hosts);
    assert.deepEqual(JSON.parse(answer.content).rows.map((r: any) => r.path), ["/inside"]);
  });

  it("returns a summary by default, with counts and no rows", async () => {
    const lines = [
      ...Array.from({ length: 30 }, (_, i) => entry(T0 + (i + 1) * MIN, 404, `/wp-${i % 3}.php?x=secret`, "203.0.113.9")),
      entry(T0 + 40 * MIN, 200, "/", "198.51.100.1"),
    ];
    const src = await source(lines);
    const answer = await runLinesCall(JSON.stringify({ host: hosts[0] }), src, period, hosts);
    const result = JSON.parse(answer.content);
    assert.equal(result.view, "summary");
    assert.equal(result.rows, undefined);
    assert.equal(result.matched, 31);
    assert.deepEqual(result.byStatus, { "404": 30, "200": 1 });
    assert.deepEqual(result.topClients[0], { client: "203.0.113.9", requests: 30 });
    assert.equal(result.topPaths[0].requests, 10);
    assert.ok(!answer.content.includes("secret"), "no query string");
    assert.equal(answer.condensed, null);
    assert.equal(answer.request?.view, "summary");
    assert.ok(answer.content.length < 1500, "a summary stays small");
  });

  it("summarises only the lines that match the filter", async () => {
    const src = await source([entry(T0 + MIN, 404, "/a", "203.0.113.9"), entry(T0 + 2 * MIN, 200, "/b", "198.51.100.1")]);
    const result = JSON.parse((await runLinesCall(JSON.stringify({ host: hosts[0], client: "198.51.100.1" }), src, period, hosts)).content);
    assert.equal(result.matched, 1);
    assert.deepEqual(result.byStatus, { "200": 1 });
  });

  it("says so when nothing matches", async () => {
    const src = await source([entry(T0 + MIN, 200, "/", "198.51.100.1")]);
    const result = JSON.parse((await runLinesCall(JSON.stringify({ host: hosts[0], status: [500] }), src, period, hosts)).content);
    assert.equal(result.matched, 0);
    assert.equal(result.topPaths, undefined);
  });

  it("gives few rows when the model does not say how many", async () => {
    const src = await source(Array.from({ length: 40 }, (_, i) => entry(T0 + (i + 1) * MIN, 200, `/p${i}`, "203.0.113.9")));
    const result = JSON.parse((await runLinesCall(JSON.stringify({ host: hosts[0], view: "rows" }), src, period, hosts)).content);
    assert.equal(result.rows.length, DEFAULT_ROWS_PER_CALL);
    assert.equal(result.more, true);
  });

  it("stops giving rows when the budget of the Review is used, but still gives summaries", async () => {
    const src = await source(Array.from({ length: 40 }, (_, i) => entry(T0 + (i + 1) * MIN, 200, `/p${i}`, "203.0.113.9")));
    const budget = { left: 25 };
    const first = JSON.parse((await runLinesCall(JSON.stringify({ host: hosts[0], view: "rows", limit: 20 }), src, period, hosts, budget)).content);
    assert.equal(first.rows.length, 20);
    assert.equal(first.rowsLeftInReview, 5);
    const second = JSON.parse((await runLinesCall(JSON.stringify({ host: hosts[0], view: "rows", limit: 20 }), src, period, hosts, budget)).content);
    assert.equal(second.rows.length, 5);
    assert.equal(budget.left, 0);
    const third = await runLinesCall(JSON.stringify({ host: hosts[0], view: "rows" }), src, period, hosts, budget);
    assert.match(JSON.parse(third.content).error, new RegExp(String(MAX_ROWS_PER_REVIEW)));
    assert.equal(third.rows, null);
    assert.equal(JSON.parse((await runLinesCall(JSON.stringify({ host: hosts[0] }), src, period, hosts, budget)).content).view, "summary");
  });

  it("offers a short form of rows to replace them in later rounds", async () => {
    const src = await source(Array.from({ length: 12 }, (_, i) => entry(T0 + (i + 1) * MIN, 404, `/p${i % 2}`, "203.0.113.9")));
    const answer = await runLinesCall(JSON.stringify({ host: hosts[0], view: "rows" }), src, period, hosts);
    assert.ok(answer.condensed);
    const condensed = JSON.parse(answer.condensed);
    assert.equal(condensed.rows, 12);
    assert.deepEqual(condensed.byStatus, { "404": 12 });
    assert.ok(answer.condensed.length < answer.content.length / 2);
  });

  it("rejects a view that does not exist", () => {
    assert.equal(parseLinesCall(JSON.stringify({ host: hosts[0], view: "raw" }), period, hosts).ok, false);
  });

  it("refuses a bad call with a reason and no rows", async () => {
    const src = await source([]);
    const answer = await runLinesCall(JSON.stringify({ host: "elsewhere.example.test" }), src, period, hosts);
    assert.equal(answer.rows, null);
    assert.equal(answer.request, null);
    assert.match(JSON.parse(answer.content).error, /not a host/);
  });
});
