import assert from "node:assert/strict"
import { test } from "node:test"
import { isFormatting, sortFindings, summarize, toMarkers, type Finding } from "../web/src/lib/findings.js"

const warn = (message: string, line?: number): Finding => ({ level: "warning", message, origin: "caddy", ...(line && { line }) })
const err = (message: string, line?: number): Finding => ({ level: "error", message, origin: "caddy", ...(line && { line }) })

test("errors come before warnings, then by line, lineless last", () => {
  const sorted = sortFindings([warn("w1", 1), warn("w-none"), err("e-none"), err("e5", 5), warn("w3", 3), err("e2", 2)])
  assert.deepEqual(sorted.map((f) => f.message), ["e2", "e5", "e-none", "w1", "w3", "w-none"])
})

test("the summary names the count and the worst level", () => {
  assert.equal(summarize([]), null)
  assert.deepEqual(summarize([warn("a"), warn("b")]), { worst: "warning", title: "2 warnings" })
  assert.deepEqual(summarize([warn("a"), err("b")]), { worst: "error", title: "1 error, 1 warning" })
})

test("the formatting warning is recognised", () => {
  assert.equal(isFormatting(warn("Caddyfile input is not formatted; run 'caddy fmt'")), true)
  assert.equal(isFormatting(warn("something else")), false)
})

test("markers cover the line text without its indent, and skip Findings without a usable line", () => {
  const text = "a.test {\n\tfoo bar  \n}\n"
  const markers = toMarkers([err("nope", 2), err("no line"), warn("far", 99)], text)
  assert.deepEqual(markers, [{ from: 10, to: 17, severity: "error", message: "nope" }])
  assert.equal(text.slice(10, 17), "foo bar")
})

test("a blank line still gets a visible marker, and the last line without a newline works", () => {
  assert.deepEqual(toMarkers([warn("x", 2)], "a\n\nb"), [{ from: 2, to: 3, severity: "warning", message: "x" }])
  assert.deepEqual(toMarkers([warn("x", 2)], "a\nbc"), [{ from: 2, to: 4, severity: "warning", message: "x" }])
})

test("only non-formatting warnings need confirming", async () => {
  const { warningsToConfirm } = await import("../web/src/lib/findings.js")
  const fmt = warn("Caddyfile input is not formatted; run 'caddy fmt'")
  assert.deepEqual(warningsToConfirm([fmt]), [])
  assert.deepEqual(warningsToConfirm([]), [])
  assert.deepEqual(
    warningsToConfirm([fmt, warn("b", 9), warn("a", 2), err("e", 1)]).map((f) => f.message),
    ["a", "b"]
  )
})
