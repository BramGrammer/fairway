import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLocalName, patternMatches, summarizeTls, type HostTls } from "../src/server/tls.js";

const route = (...hosts: string[]) => ({ match: [{ host: hosts }], handle: [{ handler: "static_response" }] });
const find = (sites: ReturnType<typeof summarizeTls>, host: string): HostTls => {
  const found = sites.flatMap((s) => s.hosts).find((h) => h.host === host);
  assert.ok(found, `no ${host}`);
  return found;
};
const https = (...hosts: string[]) => ({ srv0: { listen: [":443"], routes: [route(...hosts)] } });

describe("patternMatches", () => {
  it("covers exactly one label", () => {
    assert.ok(patternMatches("*.example.com", "a.example.com"));
    assert.ok(!patternMatches("*.example.com", "a.b.example.com"));
    assert.ok(!patternMatches("*.example.com", "example.com"));
  });
});

describe("isLocalName", () => {
  it("flags names no public CA signs", () => {
    for (const h of ["localhost", "nas", "10.0.0.1", "app.local", "x.internal"]) assert.ok(isLocalName(h), h);
    assert.ok(!isLocalName("app.example.com"));
  });
});

describe("summarizeTls", () => {
  it("defaults to Let's Encrypt and ZeroSSL over http and tls-alpn", () => {
    const host = find(summarizeTls(https("app.example.com"), {}), "app.example.com");
    assert.equal(host.state, "managed");
    assert.deepEqual(host.issuers.map((i) => i.name), ["Let's Encrypt", "ZeroSSL"]);
    assert.deepEqual(host.issuers[0].challenges, ["http", "tls-alpn"]);
  });

  it("reads issuer and DNS challenge from the matching policy", () => {
    const tls = {
      automation: {
        policies: [
          {
            subjects: ["app.example.com"],
            issuers: [
              {
                module: "acme",
                challenges: { dns: { provider: { name: "cloudflare" } }, http: { disabled: true }, "tls-alpn": { disabled: true } },
              },
            ],
          },
          { issuers: [{ module: "acme", ca: "https://acme-staging-v02.api.letsencrypt.org/directory" }] },
        ],
      },
    };
    const sites = summarizeTls(https("app.example.com", "b.example.com"), tls);
    assert.deepEqual(find(sites, "app.example.com").issuers, [
      { name: "Let's Encrypt", challenges: ["dns"], dnsProvider: "cloudflare" },
    ]);
    assert.equal(find(sites, "b.example.com").issuers[0].name, "Let's Encrypt (staging)");
  });

  it("labels on-demand hosts", () => {
    const tls = { automation: { policies: [{ on_demand: true }] } };
    assert.equal(find(summarizeTls(https("app.example.com"), tls), "app.example.com").state, "on-demand");
  });

  it("labels internal issuer and local names", () => {
    const tls = { automation: { policies: [{ subjects: ["lan.example.com"], issuers: [{ module: "internal" }] }] } };
    const sites = summarizeTls(https("lan.example.com", "nas.local"), tls);
    assert.equal(find(sites, "lan.example.com").state, "internal");
    assert.equal(find(sites, "nas.local").state, "internal");
  });

  it("labels http-only servers", () => {
    const servers = { srv0: { listen: [":80"], routes: [route("app.example.com")] } };
    assert.equal(find(summarizeTls(servers, {}), "app.example.com").state, "http-only");
  });

  it("labels manual certificates", () => {
    const servers = {
      srv0: { listen: [":443"], automatic_https: { skip_certificates: ["app.example.com"] }, routes: [route("app.example.com")] },
    };
    const tls = { certificates: { load_files: [{ certificate: "/c.pem", key: "/k.pem" }] } };
    assert.equal(find(summarizeTls(servers, tls), "app.example.com").state, "manual");
    assert.equal(find(summarizeTls(servers, {}), "app.example.com").state, "off");
  });

  it("shows hosts covered only by a wildcard", () => {
    const servers = { srv0: { listen: [":443"], routes: [route("*.example.com"), route("a.example.com")] } };
    const sites = summarizeTls(servers, {});
    const a = find(sites, "a.example.com");
    assert.equal(a.state, "wildcard-covered");
    assert.equal(a.coveredBy, "*.example.com");
    assert.equal(find(sites, "*.example.com").state, "managed");
  });

  it("shows auto HTTPS turned off as not managed", () => {
    const off = { srv0: { listen: [":443"], automatic_https: { disable: true }, routes: [route("app.example.com")] } };
    assert.equal(find(summarizeTls(off, {}), "app.example.com").state, "off");
    const skip = { srv0: { listen: [":443"], automatic_https: { skip: ["app.example.com"] }, routes: [route("app.example.com")] } };
    assert.equal(find(summarizeTls(skip, {}), "app.example.com").state, "off");
  });

  it("gives hostless routes no certificate", () => {
    const servers = { srv0: { listen: [":443"], routes: [{ handle: [{ handler: "static_response" }] }] } };
    assert.equal(find(summarizeTls(servers, {}), "*").state, "none");
  });
});
