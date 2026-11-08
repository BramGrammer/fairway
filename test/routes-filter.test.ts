import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesQuery, normalizeQuery, siteMatches } from "../web/src/features/routes-filter.js";

const site = {
  hosts: ["App.example.com"],
  listen: [":443"],
  middleware: [{ label: "encode", detail: "zstd gzip" }],
  rules: [
    {
      match: "/api/*",
      middleware: [{ label: "basic_auth" }],
      destinations: [
        { kind: "proxy" as const, summary: "proxy", upstreams: ["10.0.0.5:8080"] },
        { kind: "respond" as const, summary: "Teapot" },
      ],
    },
  ],
};

describe("normalizeQuery", () => {
  it("trims and lowercases", () => assert.equal(normalizeQuery("  FoO "), "foo"));
});

describe("matchesQuery", () => {
  it("matches everything for an empty query", () => assert.ok(matchesQuery("", ["x"])));
  it("is a case-insensitive substring match", () => assert.ok(matchesQuery("pp.exa", ["App.example.com"])));
  it("fails when no text matches", () => assert.ok(!matchesQuery("zzz", ["a", "b"])));
});

describe("siteMatches", () => {
  it("matches hostnames", () => assert.ok(siteMatches(site, "app.example")));
  it("matches upstream addresses", () => assert.ok(siteMatches(site, "10.0.0.5")));
  it("matches site and rule middleware labels", () => {
    assert.ok(siteMatches(site, "encode"));
    assert.ok(siteMatches(site, "basic_"));
  });
  it("matches non-proxy destination summaries", () => assert.ok(siteMatches(site, "teapot")));
  it("ignores paths, listeners and chip details", () => {
    assert.ok(!siteMatches(site, "/api"));
    assert.ok(!siteMatches(site, ":443"));
    assert.ok(!siteMatches(site, "zstd"));
  });
  it("matches a site without rules by host", () => {
    assert.ok(siteMatches({ ...site, rules: [] }, "app"));
  });
});
