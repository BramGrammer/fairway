/** The Assistant's Conversation as the page holds it, and the pieces that read a turn's stream and show an answer. */
import type { Finding } from "@/lib/findings"

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
}

export type ProposalStatus =
  "pending" | "accepted" | "rejected" | "replaced" | "outdated"

/**
 * A changed Caddyfile the Assistant offered with an answer. The one the running page holds (`live`) has the real
 * secrets in it and never leaves the page. One loaded from the server is history: its texts are masked, with
 * placeholders for the secrets, and it cannot be accepted.
 */
export interface Proposal {
  text: string
  /** The editor buffer it was made against, as the server or the page knew it. */
  baseText: string
  status: ProposalStatus
  /** False when Caddy refused the draft even after the Assistant's attempts to correct it. */
  valid: boolean
  /** The Findings of this text, errors and warnings. */
  findings: Finding[]
  /** How many Validations ran for it. */
  attempts: number
  /** Held by this page with its real text, so it can still be accepted. False for a Proposal loaded from the server. */
  live: boolean
}

export interface AssistantMessage {
  /** Identifies the message in the page. */
  id: number
  /** The message's id in the stored Conversation, once the server has it. */
  serverId?: number
  role: "user" | "assistant"
  /** The Owner's text as typed, or the answer as streamed. Answers hold placeholders, never real secrets. */
  content: string
  usage?: TokenUsage
  /** What the turn did, in order, as the server reported it. Not kept with a stored Conversation. */
  steps?: TurnStep[]
  /** How long the turn took from send to the end of the answer, measured here. */
  elapsedMs?: number
  /** What the request for this answer was made of, estimated. Not kept with a stored Conversation. */
  context?: ContextPart[]
  /** Set on an answer that offered a Proposal. */
  proposal?: Proposal
  /** While the turn runs: the Assistant's draft is being validated, this many Validations in. Cleared when the turn ends. */
  validating?: number
  /** An answer that did not finish normally: why, in words for the Owner. */
  problem?: { kind: "error" | "limit" | "stopped"; text: string }
}

/** The Proposal the page holds that is waiting for a decision, with the message that carries it. Only one at a time. */
export function livePending(
  messages: AssistantMessage[]
): AssistantMessage | undefined {
  return messages.find(
    (m) => m.proposal?.live && m.proposal.status === "pending"
  )
}

/** Whether a pending Proposal has been overtaken by the editor: its text is compared, so no version counter is needed. */
export function isOutdated(proposal: Proposal, editorText: string): boolean {
  return (
    proposal.live &&
    proposal.status === "pending" &&
    proposal.baseText !== editorText
  )
}

/** Why a Proposal that is outdated cannot be accepted, in words for the Owner. */
export function outdatedReason(proposal: Proposal): string {
  return proposal.live
    ? "The editor changed after this was made, so it can no longer be accepted."
    : "It was still waiting when the page was closed, so it can no longer be accepted."
}

/** The follow-up that asks for a Proposal to be made again against the editor as it is now. */
export const ASK_AGAIN =
  "The Caddyfile has changed since your last Proposal. Please make that change again against the current Caddyfile."

/** A Conversation in the list of past ones. */
export interface ConversationSummary {
  id: string
  title: string
  updatedAt: number
  messages: number
}

/** A message as the server stores it: masked, and a Proposal with its masked texts. */
export interface StoredMessage {
  id: number
  role: "user" | "assistant"
  content: string
  usage?: TokenUsage
  proposal?: Omit<Proposal, "live">
  problem?: { kind: "limit" | "stopped"; text: string }
}

/**
 * A stored Conversation as page messages. Its Proposals are history: the real text is gone, so one that was still
 * pending when the page was closed is shown as outdated.
 */
export function fromStored(messages: StoredMessage[]): AssistantMessage[] {
  return messages.map(({ id, role, content, usage, proposal, problem }) => ({
    id,
    serverId: id,
    role,
    content,
    ...(usage && { usage }),
    ...(problem && { problem }),
    ...(proposal && {
      proposal: {
        ...proposal,
        status:
          proposal.status === "pending"
            ? ("outdated" as const)
            : proposal.status,
        live: false,
      },
    }),
  }))
}

export function totalUsage(messages: AssistantMessage[]): TokenUsage {
  return messages.reduce(
    (sum, m) => ({
      promptTokens: sum.promptTokens + (m.usage?.promptTokens ?? 0),
      completionTokens: sum.completionTokens + (m.usage?.completionTokens ?? 0),
    }),
    { promptTokens: 0, completionTokens: 0 }
  )
}

const numbers = new Intl.NumberFormat("en")

export function describeUsage(usage: TokenUsage): string {
  return `${numbers.format(usage.promptTokens)} in · ${numbers.format(usage.completionTokens)} out`
}

/** Something the turn did, as the server reports it: what ran and how long it took. */
export type TurnStep =
  | { kind: "checked"; ms: number; errors: number; warnings: number }
  | { kind: "model"; ms: number; toolCalls: number }
  | { kind: "edit"; applied: boolean; edits: number }
  | {
      kind: "validate"
      attempt: number
      ms: number
      errors: number
      warnings: number
    }

const TURN_STEP_KINDS = ["checked", "model", "edit", "validate"]

/** A duration for the trace: milliseconds below a second, then seconds with a decimal, then minutes. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

/** The parts a request is made of, as the server names them. */
export const CONTEXT_KEYS = [
  "instructions",
  "placeholders",
  "caddyfile",
  "proposal",
  "findings",
  "tool",
  "conversation",
] as const
export type ContextKey = (typeof CONTEXT_KEYS)[number]
export interface ContextPart {
  key: ContextKey
  /** Estimated from the length of the text. */
  tokens: number
}

export const CONTEXT_LABELS: Record<ContextKey, string> = {
  instructions: "Instructions",
  caddyfile: "Caddyfile",
  conversation: "Conversation",
  findings: "Findings",
  proposal: "Pending Proposal",
  placeholders: "Secret placeholders",
  tool: "Edit tool",
}

/** What a Conversation has cost at the Owner's prices, in dollars per million tokens. */
export function approximateCost(
  usage: TokenUsage,
  price: { input: number; output: number }
): number {
  return (
    (usage.promptTokens * price.input + usage.completionTokens * price.output) /
    1_000_000
  )
}

export function formatCost(dollars: number): string {
  if (dollars === 0) return "$0"
  if (dollars < 0.01) return "< $0.01"
  return `≈ $${dollars.toFixed(dollars < 1 ? 3 : 2)}`
}

/** What the token indicator shows: the totals over the Conversation, and the size of the last request. */
export interface UsageBreakdown {
  input: number
  output: number
  total: number
  /** Answers that reported usage. */
  turns: number
  /** The input of the latest request, which is as much of the Conversation as the model was given. */
  lastInput: number
  /** Share of the total that is input, 0 to 1; 0 when nothing was used. */
  inputShare: number
  /** What the latest request was made of, estimated; empty when this page did not send it. */
  context: ContextPart[]
  /** The sum of the estimates in `context`. */
  contextTotal: number
}

export function usageBreakdown(messages: AssistantMessage[]): UsageBreakdown {
  const { promptTokens: input, completionTokens: output } = totalUsage(messages)
  const reported = messages.filter((m) => m.usage)
  const total = input + output
  const context = messages.findLast((m) => m.context)?.context ?? []
  return {
    input,
    output,
    total,
    turns: reported.length,
    lastInput: reported.at(-1)?.usage?.promptTokens ?? 0,
    inputShare: total === 0 ? 0 : input / total,
    context,
    contextTotal: context.reduce((sum, part) => sum + part.tokens, 0),
  }
}

export const formatTokens = (count: number): string => numbers.format(count)

export type TurnEvent =
  | {
      type: "conversation"
      id: string
      userMessageId: number
      answerMessageId: number
    }
  | { type: "text"; delta: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "context"; parts: ContextPart[] }
  | { type: "step"; step: TurnStep }
  | {
      type: "proposal"
      text: string
      valid: boolean
      findings: Finding[]
      attempts: number
    }
  | { type: "validating"; attempt: number }
  | { type: "limit"; message: string }
  | { type: "error"; reason: string; error: string }
  | { type: "done" }

/** Reads the server-sent events of a turn from a fetch body. Events it does not know are skipped. */
export async function* readTurnEvents(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<TurnEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const parse = (block: string): TurnEvent | null => {
    let name = "message"
    const data: string[] = []
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim()
      else if (line.startsWith("data:"))
        data.push(line.slice(5).replace(/^ /, ""))
    }
    if (name === "done") return { type: "done" }
    let json: Record<string, unknown>
    try {
      json = JSON.parse(data.join("\n")) as Record<string, unknown>
    } catch {
      return null
    }
    if (name === "conversation" && typeof json.id === "string") {
      return {
        type: "conversation",
        id: json.id,
        userMessageId: Number(json.userMessageId),
        answerMessageId: Number(json.answerMessageId),
      }
    }
    if (name === "text" && typeof json.delta === "string")
      return { type: "text", delta: json.delta }
    if (
      name === "usage" &&
      typeof json.usage === "object" &&
      json.usage !== null
    )
      return { type: "usage", usage: json.usage as TokenUsage }
    if (name === "context" && Array.isArray(json.parts))
      return {
        type: "context",
        parts: (json.parts as Array<Record<string, unknown>>).filter(
          (p): p is { key: ContextKey; tokens: number } =>
            CONTEXT_KEYS.includes(p.key as ContextKey) &&
            typeof p.tokens === "number"
        ),
      }
    if (
      name === "step" &&
      typeof json.step === "object" &&
      json.step !== null &&
      TURN_STEP_KINDS.includes((json.step as { kind?: string }).kind as never)
    )
      return { type: "step", step: json.step as TurnStep }
    if (name === "validating" && typeof json.attempt === "number")
      return { type: "validating", attempt: json.attempt }
    if (name === "proposal" && typeof json.text === "string") {
      const findings = Array.isArray(json.findings)
        ? (json.findings as Finding[])
        : []
      return {
        type: "proposal",
        text: json.text,
        valid: json.valid !== false,
        findings,
        attempts: typeof json.attempts === "number" ? json.attempts : 0,
      }
    }
    if (name === "limit" && typeof json.message === "string")
      return { type: "limit", message: json.message }
    if (name === "error" && typeof json.error === "string")
      return {
        type: "error",
        reason: String(json.reason ?? ""),
        error: json.error,
      }
    return null
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
      let end: number
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const event = parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 2)
        if (event) yield event
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export type TableAlign = "left" | "center" | "right"
export type AnswerBlock =
  | { type: "text"; text: string }
  | { type: "code"; code: string; language: string }
  | { type: "table"; header: string[]; align: TableAlign[]; rows: string[][] }

/** The cells of one table row: the outer pipes are optional, and `\|` is a pipe inside a cell. */
function tableCells(line: string): string[] {
  const inner = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
  return inner
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim())
}

/** A separator row such as `| --- | :-: |`; its cells say how each column is aligned. */
function separatorAlign(line: string): TableAlign[] | null {
  if (!line.includes("|") && !/^\s*:?-{3,}:?\s*$/.test(line)) return null
  const cells = tableCells(line)
  if (!cells.every((cell) => /^:?-+:?$/.test(cell))) return null
  return cells.map((cell) =>
    cell.startsWith(":") && cell.endsWith(":")
      ? "center"
      : cell.endsWith(":")
        ? "right"
        : "left"
  )
}

/** Splits lines of prose into text and pipe tables. A table needs its header row and its separator row; until the separator has arrived, as while streaming, the lines stay text. */
function splitProse(lines: string[]): AnswerBlock[] {
  const blocks: AnswerBlock[] = []
  let text: string[] = []
  const flush = () => {
    const joined = text.join("\n").replace(/^\n+|\n+$/g, "")
    if (joined !== "") blocks.push({ type: "text", text: joined })
    text = []
  }
  for (let i = 0; i < lines.length; i++) {
    const align =
      lines[i]!.includes("|") && i + 1 < lines.length
        ? separatorAlign(lines[i + 1]!)
        : null
    const header = align ? tableCells(lines[i]!) : []
    if (align && header.length === align.length) {
      flush()
      const rows: string[][] = []
      let at = i + 2
      while (
        at < lines.length &&
        lines[at]!.includes("|") &&
        lines[at]!.trim() !== ""
      ) {
        const cells = tableCells(lines[at]!)
        rows.push(header.map((_, column) => cells[column] ?? ""))
        at++
      }
      blocks.push({ type: "table", header, align, rows })
      i = at - 1
    } else {
      text.push(lines[i]!)
    }
  }
  flush()
  return blocks
}

/** Splits an answer into prose, pipe tables and fenced code blocks. A fence still open, as while streaming, counts as code so far. */
export function splitAnswer(content: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = []
  let prose: string[] = []
  let code: string[] | null = null
  let language = ""
  const flushProse = () => {
    blocks.push(...splitProse(prose))
    prose = []
  }
  for (const line of content.split("\n")) {
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line)
    if (code === null && fence) {
      flushProse()
      code = []
      language = fence[1] ?? ""
    } else if (code !== null && /^\s*```\s*$/.test(line)) {
      blocks.push({ type: "code", code: code.join("\n"), language })
      code = null
    } else if (code !== null) {
      code.push(line)
    } else {
      prose.push(line)
    }
  }
  if (code !== null)
    blocks.push({ type: "code", code: code.join("\n"), language })
  else flushProse()
  return blocks
}

export type InlinePart = { type: "text" | "code" | "bold"; text: string }

/** Inline `code` and **bold** in a line of prose. Nothing else is interpreted. */
export function splitInline(text: string): InlinePart[] {
  const parts: InlinePart[] = []
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g
  let at = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > at)
      parts.push({ type: "text", text: text.slice(at, match.index) })
    parts.push(
      match[1] !== undefined
        ? { type: "code", text: match[1] }
        : { type: "bold", text: match[2]! }
    )
    at = match.index + match[0].length
  }
  if (at < text.length) parts.push({ type: "text", text: text.slice(at) })
  return parts
}

/** Whether Enter sends: Enter alone does, Shift+Enter makes a new line, and a composing input method is left alone. */
export function sendsOnKey(event: {
  key: string
  shiftKey: boolean
  isComposing?: boolean
}): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing
}
