import assert from "node:assert/strict"
import { test } from "node:test"
import { createLiveCheck } from "../web/src/lib/live-check.js"

function setup() {
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  const runs: { text: string; resolve: (r: string[] | null) => void; reject: (e: unknown) => void }[] = []
  const results: (string[] | null)[] = []
  const check = createLiveCheck<string[]>({
    delay: 1000,
    run: (text) =>
      new Promise((resolve, reject) => {
        runs.push({ text, resolve, reject })
      }),
    onResult: (r) => results.push(r),
    setTimer: (fn, ms) => {
      timers.set(next, { fn, ms })
      return next++
    },
    clearTimer: (h) => void timers.delete(h as number),
  })
  const fireTimer = () => {
    const [id, t] = [...timers.entries()][0]!
    timers.delete(id)
    t.fn()
  }
  const tick = () => new Promise((r) => setImmediate(r))
  return { check, timers, runs, results, fireTimer, tick }
}

test("each keystroke restarts the quiet period; one check runs after it", () => {
  const s = setup()
  s.check.input("a")
  s.check.input("ab")
  s.check.input("abc")
  assert.equal(s.timers.size, 1)
  assert.equal(s.runs.length, 0)
  s.fireTimer()
  assert.deepEqual(s.runs.map((r) => r.text), ["abc"])
})

test("an answer for the current text is delivered", async () => {
  const s = setup()
  s.check.input("a")
  s.fireTimer()
  s.runs[0]!.resolve(["w"])
  await s.tick()
  assert.deepEqual(s.results, [["w"]])
})

test("an edit during a request waits for it, then exactly one more check runs; the stale answer is dropped", async () => {
  const s = setup()
  s.check.input("a")
  s.fireTimer()
  s.check.input("ab")
  s.fireTimer() // quiet period over while "a" is still in flight
  assert.equal(s.runs.length, 1)
  s.runs[0]!.resolve(["old"])
  await s.tick()
  assert.deepEqual(s.results, [])
  assert.deepEqual(s.runs.map((r) => r.text), ["a", "ab"])
  s.runs[1]!.resolve(["new"])
  await s.tick()
  assert.deepEqual(s.results, [["new"]])
  assert.equal(s.runs.length, 2)
})

test("an edit whose quiet period has not ended yet does not start a second request", async () => {
  const s = setup()
  s.check.input("a")
  s.fireTimer()
  s.check.input("ab")
  s.runs[0]!.resolve(["old"])
  await s.tick()
  assert.deepEqual(s.results, [])
  assert.equal(s.runs.length, 1)
  s.fireTimer()
  assert.deepEqual(s.runs.map((r) => r.text), ["a", "ab"])
})

test("a failed check reports null once and does not retry", async () => {
  const s = setup()
  s.check.input("a")
  s.fireTimer()
  s.runs[0]!.reject(new Error("offline"))
  await s.tick()
  assert.deepEqual(s.results, [null])
  assert.equal(s.runs.length, 1)
  assert.equal(s.timers.size, 0)
})

test("dispose drops the timer and ignores a late answer", async () => {
  const s = setup()
  s.check.input("a")
  s.fireTimer()
  s.check.dispose()
  s.runs[0]!.resolve(["w"])
  await s.tick()
  assert.deepEqual(s.results, [])
  s.check.input("b")
  assert.equal(s.timers.size, 0)
})

test("an edit that arrives after the quiet period ended mid-request waits its own quiet period, with no duplicate check", async () => {
  const s = setup()
  s.check.input("a")
  s.fireTimer()
  s.check.input("ab")
  s.fireTimer() // quiet period over while "a" is in flight
  s.check.input("abc") // typing goes on, a new quiet period starts
  s.runs[0]!.resolve(["old"])
  await s.tick()
  assert.equal(s.runs.length, 1) // nothing starts before the new quiet period ends
  s.fireTimer()
  assert.deepEqual(s.runs.map((r) => r.text), ["a", "abc"])
  s.runs[1]!.resolve(["new"])
  await s.tick()
  assert.deepEqual(s.results, [["new"]])
  assert.equal(s.runs.length, 2)
})
