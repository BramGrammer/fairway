/**
 * A turn of the Assistant inside a stored Conversation (ADR 0008). The server owns the Conversation: the browser
 * sends the editor buffer and the Owner's new message, and this loads the Conversation, runs the turn, and keeps the
 * Owner's message, the answer and any Proposal as the turn proceeds. Everything kept is masked.
 */
import { ASSISTANT_LIMITS, conversationTooLong, runTurn, type ConversationMessage, type TurnDeps, type TurnEvent } from "./assistant.js";
import { PROPOSAL_STATES, titleOf, type Conversation, type Conversations, type ProposalState, type StoredMessage, type StoredProposal } from "./conversations.js";
import { maskKnown, maskWithPending, type Numbering } from "./masking.js";

export interface TurnBody {
  /** The Conversation to continue, or null for a new one. */
  conversationId: string | null;
  /** The editor buffer at the moment the Owner sent the message, saved or not. */
  text: string;
  /** The Owner's new message. */
  message: string;
  /** The Proposal that is pending in the page, with its real text. The turn revises it. */
  pending: { messageId: number; text: string } | null;
}

/** The first event of a turn: which Conversation it belongs to and the ids of the two new messages. */
export type ConversationEvent = { type: "conversation"; id: string; userMessageId: number; answerMessageId: number } | Exclude<TurnEvent, { type: "proposal" }> | ProposalEvent;
/** The Proposal as the browser gets it: the real text, once, for the running turn. What is stored is masked. */
export type ProposalEvent = { type: "proposal"; text: string; valid: boolean; findings: Extract<TurnEvent, { type: "proposal" }>["findings"]; attempts: number; messageId: number };

export function checkTurnBody(body: unknown): { ok: true; body: TurnBody } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (typeof body !== "object" || body === null) return bad("Send a JSON object.");
  const { conversationId, text, message, pending } = body as Record<string, unknown>;
  if (conversationId !== null && conversationId !== undefined && typeof conversationId !== "string") return bad("The Conversation id must be text or null.");
  if (typeof text !== "string") return bad("Send the Caddyfile text as text.");
  if (typeof message !== "string" || message.trim() === "") return bad("Send the Owner's message as text.");
  if (text.length > ASSISTANT_LIMITS.maxCaddyfileChars) return bad("The Caddyfile is too large for the Assistant.");
  let pendingChecked: TurnBody["pending"] = null;
  if (pending !== null && pending !== undefined) {
    const p = pending as { messageId?: unknown; text?: unknown };
    if (typeof p !== "object" || typeof p.messageId !== "number" || typeof p.text !== "string") return bad("A pending Proposal needs the id of its message and its text.");
    if (p.text.length > ASSISTANT_LIMITS.maxCaddyfileChars) return bad("The Caddyfile is too large for the Assistant.");
    pendingChecked = { messageId: p.messageId, text: p.text };
  }
  return { ok: true, body: { conversationId: conversationId ?? null, text, message, pending: pendingChecked } };
}

const PROPOSAL_NOTES: Record<ProposalState, string> = {
  pending: "the Owner has not decided on it yet",
  accepted: "the Owner accepted it into the editor (not deployed)",
  rejected: "the Owner rejected it",
  replaced: "a later Proposal replaced it",
  outdated: "the editor changed after it was made, so it can no longer be accepted",
};

/** The note that tells the model what became of a Proposal. The Proposal's text is not sent again. */
export function proposalNote(proposal: StoredProposal): string {
  return `[Fairway: this answer offered a Proposal (${proposal.valid ? "Caddy accepts it" : "Caddy does not accept it yet"}); ${PROPOSAL_NOTES[proposal.status]}.]`;
}

/** What the model is sent of the Conversation so far: the masked messages, each Proposal as a note with its state. */
export function toModelMessages(messages: StoredMessage[]): ConversationMessage[] {
  return messages
    .map(({ role, content, proposal }) => ({ role, content: proposal ? `${content}${content === "" ? "" : "\n\n"}${proposalNote(proposal)}` : content }))
    .filter((m) => m.content.trim() !== "");
}

export type StartResult = { ok: true; events: AsyncGenerator<ConversationEvent> } | { ok: false; status: 400 | 404; error: string };

/** Starts a turn in a Conversation. Refuses before anything is sent or stored when the Conversation cannot be continued. */
export function startConversationTurn(store: Conversations, deps: TurnDeps, body: TurnBody): StartResult {
  const conversation = store.open(body.conversationId);
  if (!conversation) return { ok: false, status: 404, error: "That Conversation is gone. Start a new one." };
  const numbering: Numbering = { numbers: conversation.numbering, key: store.hash };
  const live = body.pending ? conversation.messages.find((m) => m.id === body.pending!.messageId && m.proposal?.status === "pending") : undefined;
  const masking = maskWithPending(body.text, live && body.pending ? body.pending.text : null, numbering);
  const message = maskKnown(masking, body.message.trim());
  const history = toModelMessages(conversation.messages);
  if (conversationTooLong(history.length + 1, history.reduce((sum, m) => sum + m.content.length, message.length))) {
    return { ok: false, status: 400, error: "This Conversation has grown too long to continue. Start a new one." };
  }
  return { ok: true, events: conversationTurn(store, conversation, deps, body, masking, message, history, live) };
}

async function* conversationTurn(
  store: Conversations,
  conversation: Conversation,
  deps: TurnDeps,
  body: TurnBody,
  masking: ReturnType<typeof maskWithPending>,
  message: string,
  history: ConversationMessage[],
  live: StoredMessage | undefined,
): AsyncGenerator<ConversationEvent> {
  const before = { messages: conversation.messages.length, title: conversation.title, updatedAt: conversation.updatedAt, usage: { ...conversation.usage } };
  const nextId = conversation.messages.reduce((max, m) => Math.max(max, m.id), 0) + 1;
  const user: StoredMessage = { id: nextId, role: "user", content: message };
  const answer: StoredMessage = { id: nextId + 1, role: "assistant", content: "" };
  // A Proposal pending in the store that the page does not hold any more has lost its real text: it is outdated.
  for (const m of conversation.messages) if (m.proposal?.status === "pending" && m !== live) m.proposal.status = "outdated";
  conversation.messages.push(user, answer);
  if (conversation.title === "") conversation.title = titleOf(message);
  let failed = false;
  let finished = false;
  try {
    yield { type: "conversation", id: conversation.id, userMessageId: user.id, answerMessageId: answer.id };
    const request = { text: body.text, messages: [...history, { role: "user" as const, content: message }], masking };
    for await (const event of runTurn(deps, request)) {
      if (event.type === "text") answer.content += event.delta;
      else if (event.type === "usage") {
        answer.usage = event.usage;
        conversation.usage = { promptTokens: conversation.usage.promptTokens + event.usage.promptTokens, completionTokens: conversation.usage.completionTokens + event.usage.completionTokens };
      } else if (event.type === "limit") answer.problem = { kind: "limit", text: event.message };
      else if (event.type === "error") {
        if (event.reason === "aborted") answer.problem = { kind: "stopped", text: "Stopped." };
        else failed = true;
      } else if (event.type === "proposal") {
        if (live?.proposal?.status === "pending") live.proposal.status = "replaced";
        answer.proposal = { status: "pending", valid: event.valid, attempts: event.attempts, ...event.stored };
        const { stored: _stored, ...rest } = event;
        yield { ...rest, messageId: answer.id };
        continue;
      }
      yield event as ConversationEvent;
    }
    finished = true;
  } finally {
    // A stopped turn keeps its partial answer; a failed one is not kept at all, nor the question that led to it.
    if (failed) {
      conversation.messages.splice(before.messages);
      conversation.title = before.title;
      conversation.usage = before.usage;
      if (live?.proposal?.status === "replaced") live.proposal.status = "pending";
    } else {
      if (!finished && !answer.problem) answer.problem = { kind: "stopped", text: "Stopped." };
      conversation.updatedAt = store.now();
    }
    store.prune(conversation.id);
    await store.save().catch(() => undefined);
  }
}
