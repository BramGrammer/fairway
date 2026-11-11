import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bellState,
  describeBell,
  describeSnooze,
  formatSnoozeEnd,
  hostAlertsOf,
  isSnoozed,
  kindBody,
  snoozeBody,
  toggleBody,
} from "../web/src/lib/host-alerts.js";

const on = { enabled: true, kinds: { cert: true, host: true, upstream: true }, snoozedUntil: null };
const NOW = new Date(2026, 5, 10, 12, 0).getTime();
const H = 3_600_000;

test("a host nobody set anything for sends no Alerts and has every kind", () => {
  const alerts = hostAlertsOf({ "app.example.com": on }, "other.example.com");
  assert.equal(alerts.enabled, false);
  assert.deepEqual(alerts.kinds, { cert: true, host: true, upstream: true });
  assert.equal(alerts.snoozedUntil, null);
  assert.equal(hostAlertsOf(undefined, "x.example.com").enabled, false);
  assert.equal(hostAlertsOf({}, "constructor").enabled, false);
});

test("a known host is returned as set", () => {
  const set = { ...on, kinds: { cert: false, host: true, upstream: true } };
  assert.equal(hostAlertsOf({ "app.example.com": set }, "app.example.com").kinds.cert, false);
});

test("snooze counts only while it lies ahead", () => {
  assert.equal(isSnoozed({ snoozedUntil: null }, NOW), false);
  assert.equal(isSnoozed({ snoozedUntil: NOW - 1 }, NOW), false);
  assert.equal(isSnoozed({ snoozedUntil: NOW + H }, NOW), true);
});

test("snooze end shows the time today and the day when later", () => {
  assert.match(formatSnoozeEnd(NOW + H, NOW), /^\d{2}:\d{2}$/);
  assert.match(formatSnoozeEnd(NOW + 30 * H, NOW), /^\S+ \d{2}:\d{2}$/);
  assert.match(describeSnooze(NOW + H, NOW), /^Snoozed until \d{2}:\d{2}$/);
});

test("the bell is off, on or snoozed", () => {
  assert.equal(bellState({ ...on, enabled: false }, NOW), "off");
  assert.equal(bellState(on, NOW), "on");
  assert.equal(bellState({ ...on, snoozedUntil: NOW + H }, NOW), "snoozed");
  assert.equal(bellState({ ...on, snoozedUntil: NOW - H }, NOW), "on");
  // A snooze on a host that is off does not turn the bell on.
  assert.equal(bellState({ ...on, enabled: false, snoozedUntil: NOW + H }, NOW), "off");
  assert.equal(describeBell(on, NOW), "Alerts on");
  assert.equal(describeBell({ ...on, enabled: false }, NOW), "Alerts off");
  assert.match(describeBell({ ...on, snoozedUntil: NOW + H }, NOW), /^Alerts snoozed until \d{2}:\d{2}$/);
});

test("bodies for the server", () => {
  assert.deepEqual(toggleBody("app.example.com", true), { hosts: { "app.example.com": { enabled: true } } });
  assert.deepEqual(kindBody("app.example.com", "host", false), { hosts: { "app.example.com": { kinds: { host: false } } } });
  assert.deepEqual(snoozeBody("app.example.com", 60), { hosts: { "app.example.com": { snoozeMinutes: 60 } } });
  assert.deepEqual(snoozeBody("app.example.com", null), { hosts: { "app.example.com": { snoozeMinutes: null } } });
});
