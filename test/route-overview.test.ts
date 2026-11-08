import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeNode, type OverviewData } from "../web/src/features/route-overview.js";

const geo = { label: "geo: NL DE", detail: "Only these countries are allowed: NL, DE" };
const zip = { label: "compression", detail: "zstd, gzip" };

const site = {
  hosts: ["app.example.com", "www.example.com"],
  listen: [":443"],
  middleware: [zip],
  rules: [
    {
      match: "path /api/*",
      middleware: [geo],
      destinations: [{ kind: "proxy" as const, summary: "proxy to a:1, b:2", upstreams: ["a:1", "b:2"] }],
    },
    { match: "", middleware: [], destinations: [{ kind: "respond" as const, summary: "respond 200" }] },
  ],
};

const hostId = "host:app.example.com,www.example.com|:443";
const handlerId = "handler:compression|geo: NL DE";
const data: OverviewData = {
  raw: {
    hosts: new Map([[hostId, { site }]]),
    handlers: new Map([[handlerId, { chips: [zip, geo] }]]),
    dests: new Map([
      ["proxy:a:1", { dest: { ...site.rules[0].destinations[0], upstreams: ["a:1"] } }],
      ["proxy:b:2", { dest: { ...site.rules[0].destinations[0], upstreams: ["b:2"] } }],
    ]),
    paths: [
      { host: hostId, handler: handlerId, dest: "proxy:a:1", match: "path /api/*" },
      { host: hostId, handler: handlerId, dest: "proxy:b:2", match: "path /api/*" },
    ],
  },
  groups: [{ id: "dest-group:a", label: "a", column: "dest", members: ["proxy:a:1", "proxy:b:2"] }],
  destWeights: new Map([
    ["proxy:a:1", 30],
    ["proxy:b:2", 10],
  ]),
};

describe("describeNode", () => {
  it("describes a site with hosts, ports, site-wide middleware and every rule", () => {
    const view = describeNode(data, hostId);
    assert.equal(view?.kind, "site");
    if (view?.kind !== "site") return;
    assert.deepEqual(view.hosts, site.hosts);
    assert.deepEqual(view.listen, [":443"]);
    assert.deepEqual(view.middleware, [zip]);
    assert.equal(view.rules.length, 2);
    assert.deepEqual(view.rules[0].middleware, [geo]);
  });

  it("splits a rule's middleware into inherited and own", () => {
    const view = describeNode(data, handlerId);
    assert.equal(view?.kind, "rule");
    if (view?.kind !== "rule") return;
    assert.equal(view.instances.length, 1);
    assert.equal(view.instances[0].siblings, 1, "the Site has one other rule");
    const [one] = view.instances;
    assert.equal(one.match, "path /api/*");
    assert.deepEqual(one.inherited, [zip]);
    assert.deepEqual(one.own, [geo]);
    assert.deepEqual(one.destinations.map((d) => d.label), ["a:1", "b:2"]);
  });

  it("describes a destination with its sources and traffic share", () => {
    const view = describeNode(data, "proxy:a:1");
    assert.equal(view?.kind, "destination");
    if (view?.kind !== "destination") return;
    assert.equal(view.sources.length, 1);
    assert.equal(view.sources[0].match, "path /api/*");
    assert.equal(view.sources[0].siblings, 1);
    assert.deepEqual(view.sources[0].hosts, site.hosts);
    assert.equal(view.share, 0.75);
  });

  it("has no share without traffic", () => {
    const view = describeNode({ ...data, destWeights: null }, "proxy:a:1");
    assert.equal(view?.kind === "destination" && view.share, null);
  });

  it("lists group members with labels", () => {
    const view = describeNode(data, "dest-group:a");
    assert.equal(view?.kind, "group");
    if (view?.kind !== "group") return;
    assert.deepEqual(view.members.map((m) => [m.id, m.label]), [["proxy:a:1", "a:1"], ["proxy:b:2", "b:2"]]);
  });

  it("returns null for an unknown node", () => {
    assert.equal(describeNode(data, "nope"), null);
  });
});
