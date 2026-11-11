import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  clockLabel,
  eventName,
  eventType,
  parsePersistedEvents,
  sortKeys,
  statusRank,
  TYPE_LABELS,
} from "../web/src/lib/events-table.js"
import type { EventRecord } from "../web/src/lib/events.js"

const event = (partial: Partial<EventRecord>): EventRecord => ({ id: 1, at: 0, kind: "state", message: "", ...partial })

describe("eventType", () => {
  it("takes the type of a Subject from its prefix", () => {
    assert.equal(eventType(event({ subject: "cert:app.test" })), "cert")
    assert.equal(eventType(event({ subject: "host:app.test" })), "host")
    assert.equal(eventType(event({ subject: "upstream:10.0.0.5:3000" })), "upstream")
    assert.equal(eventType(event({ subject: "caddy" })), "caddy")
  })

  it("names the one-shot events and gaps by what they are", () => {
    assert.equal(eventType(event({ kind: "deploy_failed" })), "deploy")
    assert.equal(eventType(event({ kind: "external_edit" })), "edit")
    assert.equal(eventType(event({ kind: "rollback" })), "rollback")
    assert.equal(eventType(event({ kind: "gap" })), "fairway")
  })

  it("keeps the Subject's type for flapping and removed events, and never throws on an odd Subject", () => {
    assert.equal(eventType(event({ kind: "flapping", subject: "host:a.test" })), "host")
    assert.equal(eventType(event({ kind: "removed", subject: "upstream:x:1" })), "upstream")
    assert.equal(eventType(event({ subject: "whatever:x" })), "fairway")
    assert.equal(eventType(event({})), "fairway")
  })

  it("has a label for every type", () => {
    for (const type of ["caddy", "host", "cert", "upstream", "deploy", "edit", "rollback", "fairway"] as const) {
      assert.ok(TYPE_LABELS[type])
    }
  })
})

describe("eventName", () => {
  it("is what comes after the first colon, so an upstream keeps its port", () => {
    assert.equal(eventName({ subject: "cert:app.test" }), "app.test")
    assert.equal(eventName({ subject: "upstream:10.0.0.5:3000" }), "10.0.0.5:3000")
  })

  it("is empty when there is no name", () => {
    assert.equal(eventName({ subject: "caddy" }), "")
    assert.equal(eventName({}), "")
  })
})

describe("clockLabel", () => {
  const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min).getTime()
  const now = at(2026, 11, 11, 15, 0)

  it("is only the time today, in 24 hours", () => {
    assert.equal(clockLabel(at(2026, 11, 11, 9, 5), now), "09:05")
    assert.equal(clockLabel(at(2026, 11, 11, 23, 59), now), "23:59")
  })

  it("puts Yesterday in front of the time of the day before", () => {
    assert.equal(clockLabel(at(2026, 11, 10, 14, 32), now), "Yesterday 14:32")
    // Across midnight, even a few hours apart.
    assert.equal(clockLabel(at(2026, 11, 10, 23, 50), at(2026, 11, 11, 0, 10)), "Yesterday 23:50")
  })

  it("puts a date in front of anything older", () => {
    const label = clockLabel(at(2026, 11, 5, 8, 0), now)
    assert.match(label, /08:00$/)
    assert.ok(label.length > "08:00".length)
    assert.ok(!label.startsWith("Yesterday"))
  })

  it("treats a time ahead of now as today", () => {
    assert.equal(clockLabel(at(2026, 11, 11, 16, 0), now), "16:00")
  })
})

describe("sort keys", () => {
  it("ranks the status by how bad the new State is, with other events first", () => {
    assert.equal(statusRank(event({ state: "down" })), 3)
    assert.equal(statusRank(event({ state: "warning" })), 2)
    assert.equal(statusRank(event({ state: "ok" })), 1)
    assert.equal(statusRank(event({ kind: "gap" })), 0)
    assert.equal(statusRank(event({ kind: "flapping", state: "down" })), 0)
  })

  it("sorts by time, type label, lower-case name and delivery", () => {
    const e = event({ at: 5, subject: "cert:App.Test", delivery: "sent" })
    assert.equal(sortKeys.time(e), 5)
    assert.equal(sortKeys.type(e), "Certificate")
    assert.equal(sortKeys.name(e), "app.test")
    assert.equal(sortKeys.alert(e), "sent")
    assert.equal(sortKeys.alert(event({})), "")
  })
})

describe("parsePersistedEvents", () => {
  it("reads what the table saves", () => {
    const raw = JSON.stringify({ sorting: [{ id: "status", desc: true }], visibility: { name: false } })
    assert.deepEqual(parsePersistedEvents(raw), { sorting: [{ id: "status", desc: true }], visibility: { name: false } })
  })

  it("drops anything unexpected, including the columns of the routes table", () => {
    const raw = JSON.stringify({ sorting: [{ id: "host", desc: false }], visibility: { host: false, type: "no", alert: true } })
    assert.deepEqual(parsePersistedEvents(raw), { sorting: [], visibility: { alert: true } })
    assert.deepEqual(parsePersistedEvents("not json"), { sorting: [], visibility: {} })
    assert.deepEqual(parsePersistedEvents(null), { sorting: [], visibility: {} })
  })
})
