import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lastIssuanceError } from "../src/server/issuance.js";

// Synthetic lines in the JSON shape Caddy's default logger writes (real-log verification is outstanding).
const line = (fields: Record<string, unknown>) => JSON.stringify({ level: "error", ts: 1_700_000_000.5, ...fields });

const failure = (host: string, ts: number, error = "HTTP 429 urn:ietf:params:acme:error:rateLimited") =>
  line({
    ts,
    logger: "tls.obtain",
    msg: "could not get certificate from issuer",
    identifier: host,
    issuer: "acme-v02.api.letsencrypt.org-directory",
    error,
  });

const success = (host: string, ts: number, logger = "tls.obtain") =>
  line({ level: "info", ts, logger, msg: "certificate obtained successfully", identifier: host });

describe("lastIssuanceError", () => {
  it("returns the newest error for the host, with its time and issuer", () => {
    const lines = [failure("app.example.com", 1000), failure("app.example.com", 2000, "dns: timeout")];
    const found = lastIssuanceError(lines, "app.example.com");
    assert.equal(found?.at, 2_000_000);
    assert.equal(found?.message, "dns: timeout");
    assert.equal(found?.issuer, "acme-v02.api.letsencrypt.org-directory");
    assert.equal(found?.logger, "tls.obtain");
  });

  it("returns null for a host with no errors, ignoring other hosts and access lines", () => {
    const access = line({ level: "info", logger: "http.log.access.log0", msg: "handled request", request: { host: "app.example.com" } });
    assert.equal(lastIssuanceError([failure("other.example.com", 1), access, "not json"], "app.example.com"), null);
  });

  it("is cleared by a later success, but not by an earlier one", () => {
    assert.equal(lastIssuanceError([failure("a.example.com", 1000), success("a.example.com", 2000)], "a.example.com"), null);
    assert.ok(lastIssuanceError([success("a.example.com", 1000), failure("a.example.com", 2000)], "a.example.com"));
    const renewed = line({ level: "info", ts: 3000, logger: "tls.renew", msg: "certificate renewed successfully", identifier: "a.example.com" });
    assert.equal(lastIssuanceError([failure("a.example.com", 1000), renewed], "a.example.com"), null);
  });

  it("reads renew and acme client loggers, and the identifiers array", () => {
    const renew = line({ logger: "tls.renew", msg: "could not get certificate from issuer", identifier: "a.example.com", error: "boom" });
    assert.equal(lastIssuanceError([renew], "a.example.com")?.logger, "tls.renew");
    const acme = line({ logger: "tls.issuance.acme.acme_client", msg: "challenge failed", identifier: "a.example.com", error: "nope" });
    assert.equal(lastIssuanceError([acme], "a.example.com")?.message, "nope");
    const many = line({ logger: "tls.obtain", msg: "will retry", identifiers: ["a.example.com", "b.example.com"], error: "x" });
    assert.ok(lastIssuanceError([many], "b.example.com"));
  });

  it("falls back to msg when there is no error field, and ignores non-error levels", () => {
    const bare = line({ logger: "tls.obtain", msg: "unable to acquire lock", identifier: "a.example.com" });
    assert.equal(lastIssuanceError([bare], "a.example.com")?.message, "unable to acquire lock");
    const info = line({ level: "info", logger: "tls.obtain", msg: "obtaining certificate", identifier: "a.example.com" });
    assert.equal(lastIssuanceError([info], "a.example.com"), null);
  });

  it("matches wildcard identifiers against covered hosts, and ignores case", () => {
    const wildcard = failure("*.example.com", 1000);
    assert.ok(lastIssuanceError([wildcard], "a.example.com"));
    assert.equal(lastIssuanceError([wildcard], "a.b.example.com"), null);
    assert.equal(lastIssuanceError([failure("A.Example.com", 1)], "a.example.com")?.at, 1000);
  });

  it("accepts ISO timestamps and skips lines without a usable time", () => {
    const iso = line({ ts: "2026-01-02T03:04:05.000Z", logger: "tls.obtain", msg: "x", identifier: "a.example.com", error: "e" });
    assert.equal(lastIssuanceError([iso], "a.example.com")?.at, Date.parse("2026-01-02T03:04:05.000Z"));
    const none = JSON.stringify({ level: "error", logger: "tls.obtain", msg: "x", identifier: "a.example.com" });
    assert.equal(lastIssuanceError([none], "a.example.com"), null);
  });
});
