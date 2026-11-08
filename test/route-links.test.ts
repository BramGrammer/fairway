import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hostLinks, ruleLinks, upstreamLink } from "../web/src/lib/route-links.js";

describe("upstreamLink", () => {
  it("uses http for plain upstreams and keeps https when Caddy talks TLS", () => {
    assert.deepEqual(upstreamLink("app:8080"), { label: "app:8080", url: "http://app:8080", copy: "app:8080" });
    assert.deepEqual(upstreamLink("https://app:8443"), {
      label: "app:8443",
      url: "https://app:8443",
      copy: "app:8443",
    });
  });
  it("gives no link for sockets and placeholders", () => {
    assert.equal(upstreamLink("unix//run/app.sock"), null);
    assert.equal(upstreamLink("{env.UPSTREAM}:80"), null);
    assert.equal(upstreamLink("?"), null);
  });
});

describe("hostLinks", () => {
  it("links each host once, https by default", () => {
    const links = hostLinks({ hosts: ["a.example.com", "b.example.com", "a.example.com"], listen: [":443"] });
    assert.deepEqual(links.map((l) => l.url), ["https://a.example.com", "https://b.example.com"]);
    assert.equal(links[0].copy, "a.example.com");
  });
  it("uses http for HTTP-only sites", () => {
    assert.deepEqual(hostLinks({ hosts: ["a.example.com"], listen: [":80"] }).map((l) => l.url), ["http://a.example.com"]);
  });
  it("includes a non-default port", () => {
    assert.deepEqual(hostLinks({ hosts: ["a.example.com"], listen: [":8443"] }).map((l) => l.url), [
      "https://a.example.com:8443",
    ]);
  });
  it("skips wildcard and localhost hosts", () => {
    const links = hostLinks({ hosts: ["*.example.com", "localhost", "x.localhost", "ok.example.com"], listen: [":443"] });
    assert.deepEqual(links.map((l) => l.label), ["ok.example.com"]);
  });
});

describe("ruleLinks", () => {
  const site = { hosts: ["a.example.com"], listen: [":443"] };
  it("combines host and path", () => {
    assert.deepEqual(ruleLinks(site, "path /api/v1").map((l) => l.url), ["https://a.example.com/api/v1"]);
  });
  it("turns a trailing wildcard into the plain path", () => {
    assert.deepEqual(ruleLinks(site, "path /graphql*").map((l) => l.url), ["https://a.example.com/graphql"]);
    assert.deepEqual(ruleLinks(site, "path /api/*").map((l) => l.url), ["https://a.example.com/api/"]);
    assert.deepEqual(ruleLinks(site, "path /*").map((l) => l.url), ["https://a.example.com/"]);
  });
  it("gives regex and other complex matches no link", () => {
    assert.deepEqual(ruleLinks(site, "path ~ ^/x"), []);
    assert.deepEqual(ruleLinks(site, "path /a/*/b"), []);
    assert.deepEqual(ruleLinks(site, "path /a and method GET"), []);
    assert.deepEqual(ruleLinks(site, "path /a → path /b"), []);
  });
  it("links the host root for the catch-all rule", () => {
    assert.deepEqual(ruleLinks(site, "").map((l) => l.url), ["https://a.example.com"]);
  });
  it("creates one link per host and path, skipping unlinkable hosts", () => {
    const links = ruleLinks({ hosts: ["a.example.com", "*.example.com"], listen: [":80"] }, "path /x /y");
    assert.deepEqual(links.map((l) => l.url), ["http://a.example.com/x", "http://a.example.com/y"]);
  });
});
