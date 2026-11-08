import assert from "node:assert/strict";
import { test } from "node:test";
import { groupBadge, hostBadge, type TlsStatusReply } from "../web/src/lib/tls-badges.js";

const reply: TlsStatusReply = {
  ok: true,
  enabled: true,
  sweptAt: "2030-01-01T00:00:00.000Z",
  hosts: {
    "a.test": { severity: "ok", reasons: [] },
    "b.test": { severity: "amber", reasons: ["Expires in 10 days."] },
    "c.test": { severity: "red", reasons: ["Handshake failed: x", "Expired"] },
  },
};

test("healthy and unknown hosts show no badge", () => {
  assert.equal(hostBadge(["a.test"], reply), null);
  assert.equal(hostBadge(["unknown.test"], reply), null);
  assert.equal(hostBadge(["a.test"], null), null);
  assert.equal(hostBadge(["a.test"], { ok: true, enabled: false, hosts: {} }), null);
  assert.equal(hostBadge(["a.test"], { ok: false, error: "x" }), null);
});

test("amber and red hosts show a badge with their reasons", () => {
  assert.deepEqual(hostBadge(["b.test"], reply), { severity: "amber", title: "Expires in 10 days." });
  assert.deepEqual(hostBadge(["c.test"], reply), { severity: "red", title: "Handshake failed: x Expired" });
});

test("a site with several hosts shows its worst", () => {
  assert.equal(hostBadge(["a.test", "b.test", "c.test"], reply)?.severity, "red");
  assert.equal(hostBadge(["a.test", "b.test"], reply)?.severity, "amber");
});

test("a group shows the worst state of its members", () => {
  assert.equal(groupBadge([["a.test"], ["b.test"]], reply)?.severity, "amber");
  assert.equal(groupBadge([["b.test"], ["c.test"]], reply)?.severity, "red");
  assert.equal(groupBadge([["a.test"], ["a.test"]], reply), null);
  assert.match(groupBadge([["b.test"], ["c.test"]], reply)?.title ?? "", /worst/i);
});
