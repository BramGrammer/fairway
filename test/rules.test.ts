import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { durationNs, runRules } from "../src/server/rules.js";
import { siteLine } from "../src/server/site-blocks.js";

const route = (host: string, handle: object[] = [{ handler: "static_response" }]) => ({ match: [{ host: [host] }], handle, terminal: true });
const proxy = (dial: string, active?: object) => ({
  handler: "reverse_proxy",
  upstreams: [{ dial }],
  ...(active && { health_checks: { active } }),
});
const config = (routes: object[], extra: object = {}, server: object = {}) => ({
  apps: { http: { metrics: {}, servers: { srv0: { listen: [":443"], routes, ...server } } } },
  ...extra,
});
const messages = (config: unknown, text = "") => runRules(config, text).map((f) => f.message);

describe("rule: Site without an access log", () => {
  const text = "# sites\nlogged.test {\n\tlog\n}\n\nbare.test {\n\trespond ok\n}\n";
  const logged = { logs: { logger_names: { "logged.test": "log0" } } };

  it("fires for a Site whose server has no logs config, anchored on its block", () => {
    const findings = runRules(config([route("bare.test")]), text);
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0], { level: "warning", origin: "rules", line: 6, message: findings[0]!.message });
    assert.match(findings[0]!.message, /bare\.test.*Logs tab will stay empty/);
  });

  it("is quiet for a Site with a log", () => {
    assert.deepEqual(runRules(config([route("logged.test")], {}, logged), text), []);
  });

  it("fires only for the Site that is not mapped when others are", () => {
    const server = { logs: { logger_names: { "logged.test": "log0" }, skip_unmapped_hosts: true } };
    const findings = runRules(config([route("logged.test"), route("bare.test")], {}, server), text);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.line, 6);
  });

  it("leaves the line off when the block cannot be found", () => {
    const findings = runRules(config([route("imported.test")]), text);
    assert.equal(findings.length, 1);
    assert.equal("line" in findings[0]!, false);
  });

  it("is quiet when there are no Sites", () => {
    assert.deepEqual(runRules({}, text), []);
    assert.deepEqual(runRules(null, text), []);
    assert.deepEqual(runRules(config([]), text), []);
  });
});

describe("rule: health check timing", () => {
  const logs = { logs: { default_logger_name: "log0" } };
  const run = (active: object) => runRules(config([route("app.test", [proxy("10.0.0.5:80", active)])], {}, logs), "app.test {\n}\n");

  it("fires when the timeout is not shorter than the interval, naming the Site and upstream", () => {
    const findings = run({ interval: 5e9, timeout: 5e9 });
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.message, /app\.test -> 10\.0\.0\.5:80/);
    assert.match(findings[0]!.message, /timeout/);
    assert.equal(findings[0]!.line, 1);
  });

  it("fires when the interval is under one second, with durations as strings too", () => {
    assert.match(run({ interval: "500ms", timeout: "100ms" })[0]!.message, /under one second/);
    assert.match(run({ interval: 5e8, timeout: 1e8 })[0]!.message, /under one second/);
  });

  it("is quiet for a sane check, and when there is no active check", () => {
    assert.deepEqual(run({ interval: 10e9, timeout: 2e9 }), []);
    assert.deepEqual(runRules(config([route("app.test", [proxy("10.0.0.5:80")])], {}, logs), ""), []);
  });

  it("finds a check nested in a subroute", () => {
    const nested = { handler: "subroute", routes: [{ handle: [proxy("10.0.0.6:80", { interval: 1e9, timeout: 2e9 })] }] };
    assert.equal(runRules(config([route("app.test", [nested])], {}, logs), "").length, 1);
  });

  it("uses Caddy's defaults for what is left out", () => {
    assert.equal(run({ interval: 3e9 }).length, 1); // default timeout 5s is above a 3s interval
    assert.deepEqual(run({ timeout: 2e9 }), []); // default interval 30s
  });
});

describe("rule: metrics", () => {
  const logs = { logs: { default_logger_name: "log0" } };
  it("fires when apps.http has no metrics, unanchored", () => {
    const cfg = { apps: { http: { servers: { srv0: { ...logs, routes: [route("a.test")] } } } } };
    const findings = runRules(cfg, "a.test {\n}\n");
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.message, /Traffic will stay empty/);
    assert.equal("line" in findings[0]!, false);
  });
  it("is quiet when metrics are on, and with no Sites", () => {
    assert.deepEqual(runRules(config([route("a.test")], {}, logs), ""), []);
    assert.deepEqual(runRules({ apps: { http: { servers: {} } } }, ""), []);
  });
});

describe("rule: admin endpoint", () => {
  it("fires for a TCP listener and says what breaks and what to do", () => {
    const findings = runRules({ admin: { listen: "0.0.0.0:2019" } }, "");
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.message, /0\.0\.0\.0:2019/);
    assert.match(findings[0]!.message, /lose its connection to Caddy/);
    assert.match(findings[0]!.message, /Remove the admin option/);
  });
  it("is quiet for the socket, for no admin config, and for admin off", () => {
    assert.deepEqual(runRules({ admin: { listen: "unix//run/caddy/admin.sock" } }, ""), []);
    assert.deepEqual(runRules({}, ""), []);
    assert.deepEqual(runRules({ admin: { disabled: true } }, ""), []);
  });
});

describe("what has no rule", () => {
  it("says nothing about plain HTTP Sites, duplicate hosts or unresolvable upstreams", () => {
    const logs = { logs: { default_logger_name: "log0" } };
    const cfg = config([route("a.test", [proxy("nowhere.invalid:80")]), route("a.test")], {}, { ...logs, listen: [":80"] });
    assert.deepEqual(messages(cfg), []);
  });
});

describe("durationNs", () => {
  it("reads numbers and Caddy duration strings", () => {
    assert.equal(durationNs(5e9), 5e9);
    assert.equal(durationNs("250ms"), 250e6);
    assert.equal(durationNs("1m30s"), 90e9);
    assert.equal(durationNs("soon"), undefined);
    assert.equal(durationNs(undefined), undefined);
  });
});

describe("siteLine", () => {
  it("returns the 1-based line of the first matching block, skipping snippets and globals", () => {
    const text = "{\n\temail a@b.test\n}\n(snip) {\n\tlog\n}\n\na.test, b.test {\n}\n";
    assert.equal(siteLine(text, "b.test"), 8);
    assert.equal(siteLine(text, "c.test"), undefined);
  });
});
