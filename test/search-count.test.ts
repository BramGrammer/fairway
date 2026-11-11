import assert from "node:assert/strict"
import { describe, it } from "node:test"
// CodeMirror is a dependency of the web app only, so it is imported from there.
import { SearchQuery } from "../web/node_modules/@codemirror/search/dist/index.js"
import { EditorState } from "../web/node_modules/@codemirror/state/dist/index.js"
import { COUNT_LIMIT, countMatches, describeCount } from "../web/src/lib/search-count.js"

const state = (doc: string, anchor = 0, head = anchor) => EditorState.create({ doc, selection: { anchor, head } })

describe("countMatches", () => {
  it("counts the matches and finds the selected one", () => {
    const text = "log a\nlog b\nlog c"
    const count = countMatches(state(text, 6, 9), new SearchQuery({ search: "log" }))
    assert.deepEqual(count, { total: 3, current: 2, capped: false })
  })

  it("has no current match when the selection is elsewhere", () => {
    const count = countMatches(state("log a log b", 1), new SearchQuery({ search: "log" }))
    assert.deepEqual(count, { total: 2, current: null, capped: false })
  })

  it("respects case, whole word and regular expressions", () => {
    const text = "Log log logger"
    assert.equal(countMatches(state(text), new SearchQuery({ search: "log" })).total, 3)
    assert.equal(countMatches(state(text), new SearchQuery({ search: "log", caseSensitive: true })).total, 2)
    assert.equal(countMatches(state(text), new SearchQuery({ search: "log", wholeWord: true })).total, 2)
    assert.equal(countMatches(state(text), new SearchQuery({ search: "log\\w+", regexp: true })).total, 1)
  })

  it("counts nothing for an empty or invalid search", () => {
    assert.equal(countMatches(state("abc"), new SearchQuery({ search: "" })).total, 0)
    assert.equal(countMatches(state("abc"), new SearchQuery({ search: "(", regexp: true })).total, 0)
  })

  it("stops counting at the limit", () => {
    const count = countMatches(state("a".repeat(COUNT_LIMIT + 50)), new SearchQuery({ search: "a" }))
    assert.deepEqual(count, { total: COUNT_LIMIT, current: null, capped: true })
  })
})

describe("describeCount", () => {
  const none = { total: 0, current: null, capped: false }
  it("says nothing for an empty search", () => assert.equal(describeCount("", true, none), ""))
  it("says so when nothing matches or the search is invalid", () => {
    assert.equal(describeCount("x", true, none), "No results")
    assert.equal(describeCount("(", false, none), "Invalid search")
  })
  it("gives the position when a match is selected, and the total otherwise", () => {
    assert.equal(describeCount("x", true, { total: 12, current: 3, capped: false }), "3 of 12")
    assert.equal(describeCount("x", true, { total: 12, current: null, capped: false }), "12 found")
    assert.equal(describeCount("x", true, { total: 1000, current: null, capped: true }), "1000+ found")
  })
})
