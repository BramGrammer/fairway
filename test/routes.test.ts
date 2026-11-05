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
