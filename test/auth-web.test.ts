import assert from "node:assert/strict";
import { test } from "node:test";
import { decideGate, initials, isSessionLost } from "../web/src/lib/auth.js";

test("initials takes one letter from a single word and two from separated words", () => {
  assert.equal(initials("admin"), "A");
  assert.equal(initials("jane.doe"), "JD");
  assert.equal(initials("jane doe smith"), "JD");
  assert.equal(initials("a-b"), "AB");
  assert.equal(initials("  "), "?");
});

test("decideGate shows the editor when login is off or signed in, else login", () => {
  assert.deepEqual(decideGate({ mode: "none" }), { view: "editor", user: null });
  assert.deepEqual(decideGate({ mode: "login", signedIn: true, user: "owner" }), { view: "editor", user: "owner" });
  assert.deepEqual(decideGate({ mode: "login", signedIn: false, user: null }), { view: "login" });
  assert.deepEqual(decideGate({ mode: "login", signedIn: true, user: null }), { view: "login" });
});

test("isSessionLost is true for a 401 on any route except sign in and status", () => {
  assert.equal(isSessionLost("/api/caddyfile", 401), true);
  assert.equal(isSessionLost("/api/deploy", 401), true);
  assert.equal(isSessionLost("/api/caddyfile", 200), false);
  assert.equal(isSessionLost("/api/caddyfile", 403), false);
  assert.equal(isSessionLost("/api/auth/login", 401), false);
  assert.equal(isSessionLost("/api/auth/status", 401), false);
});
