import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import tls from "node:tls";
import {
  assessProbe,
  parseProbeAddr,
  probeCertificate,
  probeEligibility,
  TlsProber,
  type CertInfo,
  type ProbeResult,
} from "../src/server/tls-probe.js";

const DAY = 86_400_000;
const NOW = Date.parse("2030-01-01T00:00:00Z");
const cert = (over: Partial<CertInfo> = {}): CertInfo => ({
  issuer: "Test CA",
  subject: "app.example.test",
  names: ["app.example.test"],
  notBefore: new Date(NOW - 10 * DAY).toISOString(),
  notAfter: new Date(NOW + 60 * DAY).toISOString(),
  ...over,
});
const served = (over: Partial<CertInfo> = {}): ProbeResult => ({ ok: true, cert: cert(over) });
const inDays = (n: number) => new Date(NOW + n * DAY).toISOString();

describe("parseProbeAddr", () => {
  it("defaults the port to 443", () => {
    assert.deepEqual(parseProbeAddr("192.0.2.10"), { host: "192.0.2.10", port: 443 });
    assert.deepEqual(parseProbeAddr("caddy.internal:8443"), { host: "caddy.internal", port: 8443 });
    assert.deepEqual(parseProbeAddr("[2001:db8::1]:443"), { host: "2001:db8::1", port: 443 });
  });
  it("rejects empty or nonsense", () => {
    assert.equal(parseProbeAddr(""), null);
    assert.equal(parseProbeAddr("host:abc"), null);
  });
});

describe("assessProbe", () => {
  const rate = (r: ProbeResult, host = "app.example.test") => assessProbe(r, host, NOW).severity;
  it("is ok with plenty of time and a matching name", () => assert.equal(rate(served()), "ok"));
  it("is amber under 21 days", () => assert.equal(rate(served({ notAfter: inDays(20) })), "amber"));
  it("is ok at 21 days", () => assert.equal(rate(served({ notAfter: inDays(21) })), "ok"));
  it("is red under 7 days", () => assert.equal(rate(served({ notAfter: inDays(6) })), "red"));
  it("is red when expired", () => assert.equal(rate(served({ notAfter: inDays(-1) })), "red"));
  it("is amber for a certificate for a different name", () => {
    const a = assessProbe(served({ names: ["other.example.test"] }), "app.example.test", NOW);
    assert.equal(a.severity, "amber");
    assert.match(a.reasons.join(" "), /different name/i);
  });
  it("accepts a wildcard name", () => assert.equal(rate(served({ names: ["*.example.test"] })), "ok"));
  it("is red for a failed handshake", () => assert.equal(rate({ ok: false, error: "refused" }), "red"));
  it("takes the worst severity", () =>
    assert.equal(rate(served({ names: ["x.test"], notAfter: inDays(3) })), "red"));
});

describe("probeEligibility", () => {
  it("probes only hosts Caddy serves a real certificate for", () => {
    for (const state of ["managed", "internal", "manual"] as const) {
      assert.equal(probeEligibility("a.example.test", state), null, state);
    }
    for (const state of ["on-demand", "http-only", "wildcard-covered", "off", "none"] as const) {
      assert.ok(probeEligibility("a.example.test", state), state);
    }
    assert.ok(probeEligibility("*.example.test", "managed"));
  });
});

describe("probeCertificate against a local TLS server", () => {
  let dir: string;
  let server: tls.Server;
  let port: number;
  const seen: (string | undefined)[] = [];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "fairway-probe-"));
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
        "-days", "30", "-subj", "/O=Probe Test CA/CN=app.example.test",
        "-addext", "subjectAltName=DNS:app.example.test,DNS:www.example.test",
      ],
      { stdio: "ignore" },
    );
    const context = tls.createSecureContext({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) });
    server = tls.createServer(
      {
        SNICallback: (name, done) => {
          seen.push(name);
          done(null, context);
        },
      },
      (s) => s.end(),
    );
    server.on("tlsClientError", () => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads issuer, expiry and names, sending the host as SNI", async () => {
    const result = await probeCertificate({ host: "127.0.0.1", port }, "app.example.test", 2000);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.cert.issuer, "Probe Test CA");
    assert.deepEqual(result.cert.names, ["app.example.test", "www.example.test"]);
    const days = (Date.parse(result.cert.notAfter) - Date.now()) / DAY;
    assert.ok(days > 29 && days < 31, String(days));
    assert.ok(seen.includes("app.example.test"));
  });

  it("reports a refused connection as a failure", async () => {
    const dead = tls.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const deadPort = (dead.address() as AddressInfo).port;
    dead.close();
    const result = await probeCertificate({ host: "127.0.0.1", port: deadPort }, "app.example.test", 2000);
    assert.equal(result.ok, false);
  });
});

describe("TlsProber cache", () => {
  const make = () => {
    let now = NOW;
    let calls = 0;
    const prober = new TlsProber({
      addr: "192.0.2.10:443",
      now: () => now,
      probe: async () => {
        calls++;
        return served();
      },
    });
    return { prober, calls: () => calls, advance: (ms: number) => (now += ms) };
  };

  it("reuses a result for 10 minutes", async () => {
    const t = make();
    await t.prober.check("a.example.test");
    t.advance(9 * 60_000);
    const again = await t.prober.check("a.example.test");
    assert.equal(t.calls(), 1);
    assert.equal(again.cached, true);
    t.advance(2 * 60_000);
    await t.prober.check("a.example.test");
    assert.equal(t.calls(), 2);
  });

  it("bypasses the cache when forced", async () => {
    const t = make();
    await t.prober.check("a.example.test");
    const fresh = await t.prober.check("a.example.test", { force: true });
    assert.equal(t.calls(), 2);
    assert.equal(fresh.cached, false);
  });

  it("caches per host", async () => {
    const t = make();
    await t.prober.check("a.example.test");
    await t.prober.check("b.example.test");
    assert.equal(t.calls(), 2);
  });

  it("is disabled without an address", () => {
    assert.equal(new TlsProber({ addr: null }).enabled, false);
    assert.equal(new TlsProber({ addr: "192.0.2.10" }).enabled, true);
  });
});
