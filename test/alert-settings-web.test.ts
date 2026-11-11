import assert from "node:assert/strict"
import { test } from "node:test"
import {
  TIMING_FIELDS,
  describePublicUrl,
  describeTiming,
  groupTriggers,
  parseNumberField,
  publicUrlBody,
  timingBody,
  topicBody,
  triggerBody,
  type TriggerKey,
} from "../web/src/lib/alert-settings.js"

test("a number field accepts whole numbers inside the limits", () => {
  assert.deepEqual(parseNumberField(" 30 ", 5, 3600), { ok: true, value: 30 })
  assert.deepEqual(parseNumberField("5", 5, 3600), { ok: true, value: 5 })
  assert.deepEqual(parseNumberField("3600", 5, 3600), { ok: true, value: 3600 })
})

test("a number field rejects empty, fractional, negative and out-of-range input", () => {
  for (const text of ["", "  ", "1.5", "-3", "abc", "1e3"]) assert.equal(parseNumberField(text, 1, 10).ok, false, text)
  const low = parseNumberField("4", 5, 10)
  assert.deepEqual(low, { ok: false, error: "Use a number from 5 to 10." })
  assert.equal(parseNumberField("11", 5, 10).ok, false)
})

test("triggers are grouped in display order with their state", () => {
  const keys: TriggerKey[] = ["cert", "upstream", "caddy", "host", "deploy_failed", "external_edit", "rollback", "recovery", "flapping"]
  const triggers = Object.fromEntries(keys.map((key) => [key, { value: key !== "rollback", overridden: key === "cert" }])) as Record<TriggerKey, { value: boolean; overridden: boolean }>
  const groups = groupTriggers({ triggers })
  assert.deepEqual(groups.map((g) => g.title), ["Subjects", "Events", "Messages"])
  assert.deepEqual(groups.flatMap((g) => g.items.map((i) => i.key)), keys)
  assert.equal(groups[0]!.items[0]!.overridden, true)
  assert.equal(groups[1]!.items[2]!.value, false)
})

test("PUT bodies carry one change, and null resets", () => {
  assert.deepEqual(triggerBody("rollback", true), { triggers: { rollback: true } })
  assert.deepEqual(triggerBody("cert", null), { triggers: { cert: null } })
  assert.deepEqual(timingBody("flapChanges", 8), { timing: { flapChanges: 8 } })
  assert.deepEqual(timingBody("flapChanges", null), { timing: { flapChanges: null } })
  assert.deepEqual(publicUrlBody("  https://fairway.example.test "), { publicUrl: "https://fairway.example.test" })
  assert.deepEqual(publicUrlBody(""), { publicUrl: "" })
  assert.deepEqual(publicUrlBody(null), { publicUrl: null })
})

test("hints describe the default and the limits with the right unit", () => {
  const caddy = TIMING_FIELDS.find((f) => f.key === "caddyHoldSec")!
  assert.equal(describeTiming(caddy, { value: 10, default: 30, overridden: true, min: 5, max: 600 }), "Default 30 seconds. Allowed 5 to 600.")
  const stable = TIMING_FIELDS.find((f) => f.key === "flapStableMin")!
  assert.equal(describeTiming(stable, { value: 1, default: 1, overridden: false, min: 1, max: 60 }), "Default 1 minute. Allowed 1 to 60.")
  assert.match(describePublicUrl({ value: null, envDefault: null, overridden: false }), /no link/)
  assert.match(describePublicUrl({ value: null, envDefault: "https://fairway.example.test", overridden: false }), /fairway\.example\.test/)
})

test("a topic form keeps the current address and token when they are left empty", () => {
  assert.deepEqual(topicBody({ name: " Phone ", url: "", token: "" }, "edit"), { ok: true, body: { name: "Phone" } })
  assert.deepEqual(topicBody({ name: "Phone", url: "https://ntfy.example.test/fairway", token: "tk_x" }, "edit"), {
    ok: true,
    body: { name: "Phone", url: "https://ntfy.example.test/fairway", token: "tk_x" },
  })
  assert.equal(topicBody({ name: "Phone", url: "", token: "" }, "add").ok, false)
  assert.equal(topicBody({ name: " ", url: "https://ntfy.example.test/x", token: "" }, "add").ok, false)
})
