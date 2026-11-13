import assert from "node:assert/strict"
import { test } from "node:test"
import { readTurnEvents, sendsOnKey, splitAnswer, splitInline, fromStored, isOutdated, livePending, outdatedReason, ASK_AGAIN, totalUsage, usageBreakdown, approximateCost, formatCost, formatDuration, type AssistantMessage, type TurnEvent } from "../web/src/lib/assistant.js"

const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c))
      controller.close()
    },
  })

async function events(chunks: string[]) {
  const out: TurnEvent[] = []
  for await (const e of readTurnEvents(stream(chunks))) out.push(e)
  return out
}

test("the stream is read into events even when it is cut in the middle of one", async () => {
  const got = await events(['event: text\ndata: {"delta":"Hel', 'lo"}\n\nevent: usage\ndata: {"usage":{"promptTokens":3,"completionTokens":2}}\n\n', 'event: limit\ndata: {"message":"cut"}\n\nevent: error\ndata: {"reason":"x","error":"bad"}\n\nevent: done\ndata: {}\n\n'])
  assert.deepEqual(got, [
    { type: "text", delta: "Hello" },
    { type: "usage", usage: { promptTokens: 3, completionTokens: 2 } },
    { type: "limit", message: "cut" },
    { type: "error", reason: "x", error: "bad" },
    { type: "done" },
  ])
})

test("a stored Conversation is shown as history: its Proposals are masked and cannot be accepted", () => {
  const proposal = { valid: true, attempts: 1, findings: [], baseText: "a", text: "b" }
  const shown = fromStored([
    { id: 1, role: "user", content: "one" },
    { id: 2, role: "assistant", content: "a", proposal: { ...proposal, status: "accepted" } },
    { id: 3, role: "assistant", content: "b", proposal: { ...proposal, status: "pending" }, problem: { kind: "stopped", text: "Stopped." } },
  ])
  assert.deepEqual(shown.map((m) => m.serverId), [1, 2, 3])
  assert.deepEqual(shown.map((m) => [m.proposal?.status, m.proposal?.live]), [[undefined, undefined], ["accepted", false], ["outdated", false]])
  assert.equal(shown[2]!.problem?.kind, "stopped")
})

test("usage adds up over the Conversation", () => {
  const messages: AssistantMessage[] = [
    { id: 1, role: "user", content: "q" },
    { id: 2, role: "assistant", content: "a", usage: { promptTokens: 100, completionTokens: 10 } },
    { id: 3, role: "assistant", content: "b", usage: { promptTokens: 200, completionTokens: 20 } },
  ]
  assert.deepEqual(totalUsage(messages), { promptTokens: 300, completionTokens: 30 })
})

test("an answer is split into prose and fenced code, and an open fence counts as code", () => {
  assert.deepEqual(splitAnswer("Use this:\n```caddyfile\nrespond hi\n```\nThen reload."), [
    { type: "text", text: "Use this:" },
    { type: "code", code: "respond hi", language: "caddyfile" },
    { type: "text", text: "Then reload." },
  ])
  assert.deepEqual(splitAnswer("Try\n```\nrespond"), [{ type: "text", text: "Try" }, { type: "code", code: "respond", language: "" }])
})

test("a pipe table in an answer becomes a table with its alignment, and half a table stays text", () => {
  const answer = "Here is the comparison:\n\n| Site | Port | Notes |\n| :-- | :-: | --: |\n| `app.example.test` | 8080 | gzip |\n| api.example.test | 8080 |\n\nThat is all."
  assert.deepEqual(splitAnswer(answer), [
    { type: "text", text: "Here is the comparison:" },
    {
      type: "table",
      header: ["Site", "Port", "Notes"],
      align: ["left", "center", "right"],
      rows: [
        ["`app.example.test`", "8080", "gzip"],
        ["api.example.test", "8080", ""],
      ],
    },
    { type: "text", text: "That is all." },
  ])
  // Without the separator row, as while the answer is still arriving, it is plain text.
  assert.deepEqual(splitAnswer("| Site | Port |"), [{ type: "text", text: "| Site | Port |" }])
  // Pipes without outer bars, an escaped pipe in a cell, and a table inside a fence is code, not a table.
  assert.deepEqual(splitAnswer("a | b\n--- | ---\nx \\| y | z"), [{ type: "table", header: ["a", "b"], align: ["left", "left"], rows: [["x | y", "z"]] }])
  assert.deepEqual(splitAnswer("```\n| a | b |\n| - | - |\n```"), [{ type: "code", code: "| a | b |\n| - | - |", language: "" }])
  // A column count that does not match the header is not a table.
  assert.deepEqual(splitAnswer("| a | b |\n| - |"), [{ type: "text", text: "| a | b |\n| - |" }])
})

test("inline code and bold are found, nothing else", () => {
  assert.deepEqual(splitInline("a `b` and **c** *d*"), [
    { type: "text", text: "a " },
    { type: "code", text: "b" },
    { type: "text", text: " and " },
    { type: "bold", text: "c" },
    { type: "text", text: " *d*" },
  ])
})

test("Enter sends, Shift+Enter does not, and composing does not", () => {
  assert.equal(sendsOnKey({ key: "Enter", shiftKey: false }), true)
  assert.equal(sendsOnKey({ key: "Enter", shiftKey: true }), false)
  assert.equal(sendsOnKey({ key: "Enter", shiftKey: false, isComposing: true }), false)
  assert.equal(sendsOnKey({ key: "a", shiftKey: false }), false)
})

test("the validating and proposal events are read from the stream", async () => {
  const finding = { level: "warning", message: "careful", line: 2, origin: "rules" }
  const got = await events([
    'event: validating\ndata: {"attempt":2}\n\n',
    `event: proposal\ndata: ${JSON.stringify({ text: "a.test {\n}\n", valid: false, findings: [finding], attempts: 3 })}\n\nevent: done\ndata: {}\n\n`,
  ])
  assert.deepEqual(got, [{ type: "validating", attempt: 2 }, { type: "proposal", text: "a.test {\n}\n", valid: false, findings: [finding], attempts: 3 }, { type: "done" }])
})


const live = (status: "pending" | "accepted", baseText = "a"): AssistantMessage => ({ id: 2, serverId: 2, role: "assistant", content: "x", proposal: { text: "b", baseText, status, valid: true, findings: [], attempts: 1, live: true } })

test("a pending Proposal is outdated as soon as the editor differs from what it was made against", () => {
  const proposal = live("pending").proposal!
  assert.equal(isOutdated(proposal, "a"), false)
  assert.equal(isOutdated(proposal, "a changed"), true)
  assert.equal(isOutdated({ ...proposal, status: "accepted" }, "other"), false)
  assert.equal(isOutdated({ ...proposal, live: false }, "other"), false, "history is never marked from the editor")
  assert.match(outdatedReason(proposal), /editor changed/)
  assert.match(outdatedReason({ ...proposal, live: false }), /page was closed/)
})

test("only a pending Proposal the page holds is sent along to be revised", () => {
  assert.equal(livePending([live("pending")])?.id, 2)
  assert.equal(livePending([live("accepted")]), undefined)
  assert.equal(livePending(fromStored([{ id: 1, role: "assistant", content: "", proposal: { status: "pending", valid: true, attempts: 1, findings: [], baseText: "a", text: "b" } }])), undefined)
  assert.match(ASK_AGAIN, /make that change again/)
})

test("the token indicator adds up input and output, and reads the last request's input", () => {
  assert.deepEqual(usageBreakdown([{ id: 1, role: "user", content: "q" }]), { input: 0, output: 0, total: 0, turns: 0, lastInput: 0, inputShare: 0, context: [], contextTotal: 0 })
  const messages: AssistantMessage[] = [
    { id: 1, role: "user", content: "q" },
    { id: 2, role: "assistant", content: "a", usage: { promptTokens: 100, completionTokens: 20 } },
    { id: 3, role: "user", content: "q2" },
    { id: 4, role: "assistant", content: "b", usage: { promptTokens: 300, completionTokens: 80 } },
  ]
  assert.deepEqual(usageBreakdown(messages), { input: 400, output: 100, total: 500, turns: 2, lastInput: 300, inputShare: 0.8, context: [], contextTotal: 0 })
})

test("the overview reads the parts of the latest request, and the cost follows the prices", async () => {
  const parts = [{ key: "caddyfile" as const, tokens: 900 }, { key: "instructions" as const, tokens: 100 }]
  const messages: AssistantMessage[] = [
    { id: 1, role: "user", content: "q" },
    { id: 2, role: "assistant", content: "a", usage: { promptTokens: 1000, completionTokens: 50 }, context: [{ key: "caddyfile", tokens: 1 }] },
    { id: 3, role: "assistant", content: "b", usage: { promptTokens: 1200, completionTokens: 100 }, context: parts },
  ]
  const overview = usageBreakdown(messages)
  assert.deepEqual(overview.context, parts)
  assert.equal(overview.contextTotal, 1000)
  assert.equal(approximateCost({ promptTokens: 2_000_000, completionTokens: 500_000 }, { input: 3, output: 15 }), 13.5)
  assert.equal(formatCost(0), "$0")
  assert.equal(formatCost(0.004), "< $0.01")
  assert.equal(formatCost(0.1234), "≈ $0.123")
  assert.equal(formatCost(13.5), "≈ $13.50")
  const events = await (async () => {
    const out = []
    for await (const e of readTurnEvents(stream(['event: context\ndata: {"parts":[{"key":"caddyfile","tokens":9},{"key":"nonsense","tokens":1}]}\n\n']))) out.push(e)
    return out
  })()
  assert.deepEqual(events, [{ type: "context", parts: [{ key: "caddyfile", tokens: 9 }] }])
})

test("durations read as milliseconds, seconds or minutes, and a step event is read only when it is one of ours", async () => {
  assert.deepEqual([formatDuration(240), formatDuration(1234), formatDuration(59_949), formatDuration(125_000)], ["240 ms", "1.2 s", "59.9 s", "2 min 5 s"])
  const out = []
  for await (const e of readTurnEvents(stream(['event: step\ndata: {"step":{"kind":"edit","applied":true,"edits":2}}\n\nevent: step\ndata: {"step":{"kind":"mystery"}}\n\n']))) out.push(e)
  assert.deepEqual(out, [{ type: "step", step: { kind: "edit", applied: true, edits: 2 } }])
})
