import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { securityOf, statesFrom } from "../web/src/lib/tls-config.js";

const states = statesFrom({
  ok: true,
  sites: [
    { hosts: [{ host: "a.example", state: "managed" }] },
    { hosts: [{ host: "b.example", state: "http-only" }] },
    { hosts: [{ host: "c.example", state: "off" }] },
  ],
});

describe("securityOf", () => {
  it("marks a managed host as HTTPS", () => {
    assert.equal(securityOf(["a.example"], states)?.kind, "https");
  });

  it("marks an HTTP-only host as plain HTTP", () => {
    assert.equal(securityOf(["b.example"], states)?.kind, "http");
  });

  it("says nothing when Caddy does not manage the host or does not know it", () => {
    assert.equal(securityOf(["c.example"], states), null);
    assert.equal(securityOf(["unknown.example"], states), null);
  });

  it("uses the first host that Caddy knows", () => {
    assert.equal(securityOf(["unknown.example", "a.example"], states)?.kind, "https");
  });

  it("copes with a failed reply", () => {
    assert.equal(statesFrom({ ok: false, error: "x" }).size, 0);
  });
});
