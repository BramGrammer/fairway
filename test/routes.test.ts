import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { summarizeRoutes, type Site } from "../src/server/routes.js";

// Captured from a real Caddy: POST /adapt with test/fixtures/sample.Caddyfile.
const servers = JSON.parse(readFileSync(new URL("./fixtures/sample.servers.json", import.meta.url), "utf8"));
const sites = summarizeRoutes(servers);
const site = (host: string): Site => {
  const found = sites.find((s) => s.hosts.includes(host));
  assert.ok(found, `no site for ${host}`);
  return found;
};

describe("summarizeRoutes", () => {
  it("lists every site once, sorted by host", () => {
    assert.deepEqual(sites.map((s) => s.hosts[0]), [
      "*",
      "app.example.com",
      "cdn.example.com",
      "files.example.com",
      "media.example.com",
      "spa.example.com",
      "status.example.com",
    ]);
  });

  it("keeps all hosts of a multi-host site together", () => {
    assert.deepEqual(site("app.example.com").hosts, ["app.example.com", "www.example.com"]);
  });

  it("splits a site into rules by path, in route order, with a catch-all", () => {
    const rules = site("app.example.com").rules;
    assert.deepEqual(rules.map((r) => r.match), ["path /old", "path /api/*", ""]);
    assert.equal(rules[0].destinations[0].kind, "redirect");
    assert.equal(rules[0].destinations[0].summary, "redirect 301 to /new");
    assert.deepEqual(rules[1].destinations[0].upstreams, ["10.0.0.5:4000"]);
    assert.deepEqual(rules[2].destinations[0].upstreams, ["10.0.0.5:5173"]);
  });

  it("shows site-wide middleware once and turns a country block into a geo chip", () => {
    const labels = site("app.example.com").middleware.map((c) => c.label);
    assert.deepEqual(labels.sort(), ["compression", "geo: NL BE", "headers"]);
    assert.equal(site("app.example.com").rules.every((r) => r.middleware.length === 0), true);
  });

  it("summarises a long CDN country list and lists every upstream", () => {
    const cdn = site("cdn.example.com");
    assert.equal(cdn.middleware[0].label, "geo (CDN): NL BE DE FR GB IE +8");
    assert.match(cdn.middleware[0].detail ?? "", /JP, NZ/);
    assert.deepEqual(cdn.rules[0].destinations[0].upstreams, ["10.0.0.5:4000", "10.0.0.6:4000"]);
  });

  it("marks upstreams that Caddy reaches over TLS", () => {
    assert.deepEqual(site("media.example.com").rules[0].destinations[0].upstreams, ["https://10.0.0.7:8443"]);
  });

  it("reads the file server root from the vars handler", () => {
    const dest = site("files.example.com").rules[0].destinations[0];
    assert.equal(dest.kind, "file");
    assert.equal(dest.summary, "files from /srv (browsable)");
  });

  it("finds the file root even when a guard route sits between vars and file_server", () => {
    const spa = site("spa.example.com");
    assert.equal(spa.rules[0].destinations[0].summary, "files from /srv/spa");
    assert.deepEqual(spa.middleware.map((c) => c.label).sort(), ["WAF", "compression", "geo: NL BE"]);
  });

  it("does not show the geo-ip lookup handler as middleware", () => {
    assert.equal(site("app.example.com").middleware.some((c) => /geo-?ip/i.test(c.label)), false);
  });

  it("describes fixed responses and catch-all sites", () => {
    assert.equal(site("status.example.com").rules[0].destinations[0].summary, 'respond 200 "ok"');
    const any = site("*");
    assert.deepEqual(any.listen, [":9999"]);
    assert.equal(any.rules[0].destinations[0].summary, 'respond 200 "catch all"');
  });

  it("hides Caddy's automatic HTTP to HTTPS redirect server and copes with nothing", () => {
    const redirect = {
      srv9: { listen: [":80"], routes: [{ handle: [{ handler: "static_response", status_code: 308, headers: { Location: ["https://{http.request.host}{http.request.uri}"] } }] }] },
    };
    assert.deepEqual(summarizeRoutes(redirect), []);
    assert.deepEqual(summarizeRoutes(null), []);
  });
});

describe("Rule.matchers", () => {
  const respond = (status: number) => ({ handler: "static_response", status_code: status });
  const rulesOf = (match: Record<string, unknown>[] | undefined, handle: unknown[]) =>
    summarizeRoutes({ srv0: { listen: [":443"], routes: [{ match: (match ?? [{}]).map((set) => ({ host: ["m.test"], ...set })), handle }] } })[0].rules;
  // Documentation ranges, 22 of them.
  const ranges = Array.from({ length: 22 }, (_, i) => `198.51.${i}.0/24`);

  it("uses the matcher text as the label of a path and a method, without detail", () => {
    const [path] = rulesOf([{ path: ["/api/*"] }], [respond(200)]);
    assert.deepEqual(path.matchers, [{ label: "path /api/*" }]);
    const [method] = rulesOf([{ method: ["GET", "POST"] }], [respond(200)]);
    assert.deepEqual(method.matchers, [{ label: "method GET|POST" }]);
    assert.equal(method.match, "method GET|POST");
  });

  it("makes one chip per matcher in a set", () => {
    const [rule] = rulesOf([{ path: ["/a"], method: ["POST"] }], [respond(200)]);
    assert.deepEqual(rule.matchers.map((c) => c.label), ["path /a", "method POST"]);
  });

  it("keeps a short ip list as is", () => {
    const [rule] = rulesOf([{ remote_ip: { ranges: ["192.0.2.0/24", "203.0.113.0/24"] } }], [respond(200)]);
    assert.deepEqual(rule.matchers, [{ label: "ip 192.0.2.0/24 203.0.113.0/24" }]);
  });

  it("summarises a long ip list and puts every range in the detail, under a heading line", () => {
    const [rule] = rulesOf([{ remote_ip: { ranges } }], [respond(200)]);
    assert.equal(rule.matchers.length, 1);
    assert.equal(rule.matchers[0].label, "ip · 22 ranges");
    assert.deepEqual(rule.matchers[0].detail?.split("\n"), ["ip", ...ranges]);
    assert.match(rule.match, /^ip 198\.51\.0\.0\/24 /);
  });

  it("reads not(...) of one matcher as a negated label (the CDN-only 404 case)", () => {
    const [rule] = rulesOf([{ not: [{ remote_ip: { ranges } }] }], [respond(404)]);
    assert.deepEqual(rule.matchers.map((c) => c.label), ["not ip · 22 ranges"]);
    assert.deepEqual(rule.matchers[0].detail?.split("\n"), ["not ip", ...ranges]);
    assert.equal(rule.destinations[0].status, 404);
    const [short] = rulesOf([{ not: [{ path: ["/x"] }] }], [respond(404)]);
    assert.deepEqual(short.matchers, [{ label: "not path /x" }]);
  });

  it("handles header and vars matchers, long or short", () => {
    const [rule] = rulesOf(
      [{ header: { "X-Forwarded-For": ["a", "b", "c", "d"], Accept: ["text/html"] }, vars: { "{http.vars.tier}": ["gold"] } }],
      [respond(200)],
    );
    assert.deepEqual(rule.matchers.map((c) => c.label), ["header X-Forwarded-For · 4 values", "Accept: text/html", "http.vars.tier = gold"]);
    assert.equal(rule.matchers[0].detail, "header X-Forwarded-For\na\nb\nc\nd");
  });

  it("truncates a single long value and keeps it whole in the detail", () => {
    const pattern = "^(AAAAAAAAAA|BBBBBBBBBB|CCCCCCCCCC)$";
    const [rule] = rulesOf([{ header_regexp: { "Cf-Ipcountry": { pattern } } }], [respond(200)]);
    assert.ok(rule.matchers[0].label.length <= 32);
    assert.equal(rule.matchers[0].detail, `Cf-Ipcountry ~ ${pattern}`);
  });

  it("joins several sets of one level with 'or' in a single chip", () => {
    const [rule] = rulesOf([{ path: ["/a"] }, { path: ["/b"] }], [respond(200)]);
    assert.deepEqual(rule.matchers, [{ label: "path /a or path /b" }]);
    const [long] = rulesOf([{ path: ["/aaaaaaaaaaaaaaaa"] }, { path: ["/bbbbbbbbbbbbbbbb"] }], [respond(200)]);
    assert.deepEqual(long.matchers, [{ label: "2 alternatives", detail: "path /aaaaaaaaaaaaaaaa\nor path /bbbbbbbbbbbbbbbb" }]);
  });

  it("continues the chip list through nested subroutes", () => {
    const nested = { handler: "subroute", routes: [{ match: [{ method: ["POST"] }], handle: [respond(201)] }] };
    const rules = rulesOf([{ path: ["/api/*"] }], [nested]);
    assert.equal(rules[0].match, "path /api/* → method POST");
    assert.deepEqual(rules[0].matchers.map((c) => c.label), ["path /api/*", "method POST"]);
  });

  it("gives a rule without matcher an empty list", () => {
    const rules = rulesOf(undefined, [respond(200)]);
    assert.equal(rules[0].match, "");
    assert.deepEqual(rules[0].matchers, []);
  });
});
