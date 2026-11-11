import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildRouteMap } from "../src/server/route-map.js";

const servers = JSON.parse(readFileSync(new URL("./fixtures/sample.servers.json", import.meta.url), "utf8"));

test("an upstream lists each host that uses it once, without the scheme", () => {
  const { upstreamHosts } = buildRouteMap(servers);
  const hosts = upstreamHosts.get("upstream:10.0.0.5:4000");
  assert.ok(hosts);
  assert.ok(hosts.includes("app.example.com"));
  assert.equal(new Set(hosts).size, hosts.length);
  assert.ok(upstreamHosts.has("upstream:10.0.0.7:8443")); // https://10.0.0.7:8443 in the config
  assert.equal(buildRouteMap({}).upstreamHosts.size, 0);
});
