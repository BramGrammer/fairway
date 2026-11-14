import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createLookup, isLookupTool, LOOKUP_LIMITS, LOOKUP_TOOLS, ROUTES_TOOL } from "../src/server/assistant-lookup.js";
import { LINES_TOOL } from "../src/server/review-lines.js";

const NOW = Date.UTC(2030, 0, 8, 12, 0, 0);
const MIN = 60_000;
const SECRET = "fake-token-value-123";

const entry = (at: number, status: number, uri: string, client: string) =>
  JSON.stringify({ level: "info", ts: at / 1000, logger: "http.log.access", msg: "handled request", request: { remote_ip: client, method: "GET", host: "app.example.test", uri, headers: { "User-Agent": ["scanner/1"], Cookie: ["sid=made-up"] } }, status, duration: 0.01, size: 12 });

const logging = { logs: { web: { writer: { output: "file", filename: "/var/log/caddy/web.log" } } } };
const servers = {
  srv0: {
    listen: [":443"],
    logs: { logger_names: { "app.example.test": ["web"] } },
    routes: [
      { match: [{ host: ["app.example.test"] }], handle: [{ handler: "subroute", routes: [{ match: [{ path: ["/admin/*"] }], handle: [{ handler: "static_response", status_code: 403 }] }, { handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "10.9.8.7:4000" }] }] }] }] },
      { match: [{ host: ["other.example.test"] }], handle: [{ handler: "headers", request: { set: { Authorization: [SECRET] } } }, { handler: "reverse_proxy", upstreams: [{ dial: "10.9.8.8:5000" }] }] },
    ],
  },
};

async function rig(options: { lines?: string[]; live?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ce-lookup-"));
  await writeFile(join(dir, "web.log"), (options.lines ?? [entry(NOW - 10 * MIN, 404, "/.env?token=secret", "203.0.113.9"), entry(NOW - 5 * MIN, 200, "/", "198.51.100.1")]).join("\n") + "\n");
  const lookup = createLookup({ loadLive: async () => (options.live === false ? { ok: false, error: "no caddy" } : { ok: true, logging, servers }), logDir: dir, now: () => NOW });
  return { lookup, session: lookup.session() };
}
const call = (name: string, args: unknown = {}, id = "c1") => ({ id, name, arguments: JSON.stringify(args) });
const same = (text: string) => text;

describe("the tools", () => {
  it("are the routes and the log, and are told apart from the edit tool", () => {
    assert.deepEqual(LOOKUP_TOOLS.map((t) => t.name), [ROUTES_TOOL, LINES_TOOL]);
    assert.ok(isLookupTool(LINES_TOOL) && isLookupTool(ROUTES_TOOL));
    assert.ok(!isLookupTool("edit_caddyfile"));
  });
});

describe("the routes", () => {
  it("lists the Sites with their number of rules when no host is given", async () => {
    const { session } = await rig();
    const result = await session.run(call(ROUTES_TOOL), same);
    const content = JSON.parse(result.content);
    assert.deepEqual(content.sites.map((s: any) => s.hosts), [["app.example.test"], ["other.example.test"]]);
    assert.deepEqual(result.step, { tool: "routes", ok: true, lines: null });
  });

  it("describes one Site: its rules, what they match and where they send the request", async () => {
    const { session } = await rig();
    const result = await session.run(call(ROUTES_TOOL, { host: "APP.example.test:443" }), same);
    const [site] = JSON.parse(result.content).sites;
    assert.deepEqual(site.hosts, ["app.example.test"]);
    assert.ok(site.rules.length >= 2);
    assert.ok(site.rules.some((rule: any) => rule.destinations.some((d: any) => d.kind === "proxy" && d.upstreams?.includes("10.9.8.7:4000"))));
    assert.ok(site.rules.some((rule: any) => rule.destinations.some((d: any) => d.kind === "respond" && d.status === 403)));
  });

  it("masks what it returns with the mask it is given", async () => {
    const { session } = await rig();
    const plain = await session.run(call(ROUTES_TOOL, { host: "other.example.test" }), same);
    assert.ok(plain.content.includes("10.9.8.8:5000"), "the test needs the value in the routes");
    const masked = await session.run(call(ROUTES_TOOL, { host: "other.example.test" }), (text) => text.split("10.9.8.8:5000").join("__FAIRWAY_SECRET_1__"));
    assert.ok(!masked.content.includes("10.9.8.8:5000"));
    assert.match(masked.content, /__FAIRWAY_SECRET_1__/);
  });

  it("refuses an unknown host with the hosts there are, and bad arguments", async () => {
    const { session } = await rig();
    const unknown = await session.run(call(ROUTES_TOOL, { host: "elsewhere.example.test" }), same);
    assert.match(JSON.parse(unknown.content).error, /not a host of a Site.*app\.example\.test/);
    assert.equal(unknown.step.ok, false);
    assert.equal((await session.run(call(ROUTES_TOOL, { site: "x" }), same)).step.ok, false);
    assert.equal((await session.run({ id: "c", name: ROUTES_TOOL, arguments: "{nope" }, same)).step.ok, false);
  });
});

describe("the log", () => {
  it("answers with a summary by default, covering the last week, without the query string", async () => {
    const { session } = await rig();
    const result = await session.run(call(LINES_TOOL, { host: "app.example.test" }), same);
    const content = JSON.parse(result.content);
    assert.equal(content.view, "summary");
    assert.equal(content.matched, 2);
    assert.deepEqual(content.byStatus, { "404": 1, "200": 1 });
    assert.deepEqual(result.step, { tool: "logs", ok: true, lines: 2 });
    for (const leak of ["secret", "made-up", "Cookie"]) assert.ok(!result.content.includes(leak), leak);
  });

  it("reaches back before a day, within the week, and no further", async () => {
    const lines = [entry(NOW - 9 * 24 * 3_600_000, 200, "/older", "198.51.100.1"), entry(NOW - 3 * 24 * 3_600_000, 200, "/old", "198.51.100.1")];
    const { session } = await rig({ lines });
    const result = JSON.parse((await session.run(call(LINES_TOOL, { host: "app.example.test", view: "rows" }), same)).content);
    assert.deepEqual(result.rows.map((r: any) => r.path), ["/old"]);
  });

  it("gives rows only on request, and only as many as the turn allows", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => entry(NOW - (i + 1) * MIN, 404, `/p${i}`, "203.0.113.9"));
    const { session } = await rig({ lines });
    const first = JSON.parse((await session.run(call(LINES_TOOL, { host: "app.example.test", view: "rows", limit: 50 }), same)).content);
    assert.equal(first.rows.length, 50);
    const second = JSON.parse((await session.run(call(LINES_TOOL, { host: "app.example.test", view: "rows", limit: 50 }), same)).content);
    assert.equal(second.rows.length, LOOKUP_LIMITS.maxRows - 50);
    const third = await session.run(call(LINES_TOOL, { host: "app.example.test", view: "rows" }), same);
    assert.match(JSON.parse(third.content).error, /used up/);
    assert.equal(third.step.ok, false);
  });

  it("masks what it returns and its short form", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => entry(NOW - (i + 1) * MIN, 404, `/reset/${SECRET}`, "203.0.113.9"));
    const { session } = await rig({ lines });
    const result = await session.run(call(LINES_TOOL, { host: "app.example.test", view: "rows" }), (text) => text.split(SECRET).join("__FAIRWAY_SECRET_1__"));
    assert.ok(!result.content.includes(SECRET));
    assert.ok(result.condensed && !result.condensed.includes(SECRET));
    assert.match(result.content, /__FAIRWAY_SECRET_1__/);
  });

  it("refuses a host that is not a Site", async () => {
    const { session } = await rig();
    const result = await session.run(call(LINES_TOOL, { host: "elsewhere.example.test" }), same);
    assert.match(JSON.parse(result.content).error, /not a host/);
    assert.deepEqual(result.step, { tool: "logs", ok: false, lines: null });
  });
});

describe("a turn's lookups", () => {
  it("are limited in number", async () => {
    const { session } = await rig();
    for (let i = 0; i < LOOKUP_LIMITS.maxCalls; i++) {
      assert.ok(session.available());
      await session.run(call(ROUTES_TOOL), same);
    }
    assert.equal(session.available(), false);
  });

  it("start afresh in the next turn", async () => {
    const { lookup, session } = await rig();
    for (let i = 0; i < LOOKUP_LIMITS.maxCalls; i++) await session.run(call(ROUTES_TOOL), same);
    assert.ok(lookup.session().available());
  });

  it("say so when Caddy's running configuration cannot be read, for either tool", async () => {
    const { session } = await rig({ live: false });
    for (const name of [ROUTES_TOOL, LINES_TOOL]) {
      const result = await session.run(call(name, { host: "app.example.test" }), same);
      assert.match(JSON.parse(result.content).error, /could not be read/);
      assert.equal(result.step.ok, false);
    }
  });

  it("read the running configuration once, however many calls", async () => {
    let loads = 0;
    const lookup = createLookup({ loadLive: async () => (loads++, { ok: true, logging, servers }), logDir: tmpdir(), now: () => NOW });
    const session = lookup.session();
    await session.run(call(ROUTES_TOOL), same);
    await session.run(call(ROUTES_TOOL, { host: "app.example.test" }), same);
    assert.equal(loads, 1);
  });
});
