/**
 * Conversations with the Assistant (ADR 0008), kept in one JSON file in the data folder for 30 days after their last
 * turn. They hold only masked text: the Owner's messages and the answers with placeholders, and each Proposal as the
 * masked base and the masked proposed text. The values behind the placeholders are never stored, only a keyed hash of
 * each, so a value keeps its placeholder for the whole Conversation.
 */
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Finding } from "./findings.js";
import { isNumber, isRecord, writeJsonAtomic } from "./json-file.js";

const FILE_VERSION = 1;

/** Conversations whose last turn is older than this are removed. */
export const CONVERSATION_RETENTION_MS = 30 * 24 * 3_600_000;
/** The most Conversations kept; the one with the oldest last turn goes first. */
export const MAX_CONVERSATIONS = 200;
const MAX_TITLE = 60;

export type ProposalState = "pending" | "accepted" | "rejected" | "replaced" | "outdated";
export const PROPOSAL_STATES: readonly ProposalState[] = ["pending", "accepted", "rejected", "replaced", "outdated"];

/** A Proposal as stored: masked, history only. */
export interface StoredProposal {
  status: ProposalState;
  valid: boolean;
  attempts: number;
  findings: Finding[];
  /** The editor buffer it was made against, masked. */
  baseText: string;
  /** The proposed Caddyfile, masked. */
  text: string;
}

export interface StoredMessage {
  /** Counts up within the Conversation. */
  id: number;
  role: "user" | "assistant";
  content: string;
  usage?: { promptTokens: number; completionTokens: number };
  proposal?: StoredProposal;
  /** An answer that was stopped or cut off at a limit. Answers that failed are not kept. */
  problem?: { kind: "limit" | "stopped"; text: string };
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
  usage: { promptTokens: number; completionTokens: number };
  /** Keyed hash of a secret value to the number of its placeholder. Never the values. */
  numbering: Record<string, number>;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  messages: number;
}

export interface ConversationsOptions {
  file: string;
  /** Key of the hashes behind the placeholder numbers; derived from the secret in the data folder. */
  key: Buffer;
  now?: () => number;
}

/** The key for the placeholder hashes, derived from the signing secret so the two are never the same bytes. */
export const placeholderKey = (secret: Buffer) => createHmac("sha256", secret).update("fairway-conversation-placeholders").digest();

export function titleOf(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 3)}...` : line;
}

export class Conversations {
  private records = new Map<string, Conversation>();

  constructor(private readonly options: ConversationsOptions) {}

  now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The keyed hash of a secret value, for the numbering of a Conversation. */
  readonly hash = (value: string): string => createHmac("sha256", this.options.key).update(value).digest("hex");

  async load(): Promise<void> {
    let data: unknown;
    try {
      data = JSON.parse(await readFile(this.options.file, "utf8"));
    } catch {
      return;
    }
    if (!isRecord(data) || data.version !== FILE_VERSION || !Array.isArray(data.conversations)) return;
    for (const record of data.conversations) if (isConversation(record)) this.records.set(record.id, record);
    const before = this.records.size;
    this.prune();
    if (this.records.size !== before) await this.save();
  }

  /** Writes every Conversation that has a message. */
  async save(): Promise<void> {
    await writeJsonAtomic(this.options.file, { version: FILE_VERSION, conversations: [...this.records.values()].filter((c) => c.messages.length > 0) }, 0o600);
  }

  /** A new, empty Conversation. It is only listed and saved once it has a message. */
  create(): Conversation {
    const now = this.now();
    const conversation: Conversation = { id: randomUUID(), title: "", createdAt: now, updatedAt: now, messages: [], usage: { promptTokens: 0, completionTokens: 0 }, numbering: {} };
    this.records.set(conversation.id, conversation);
    return conversation;
  }

  get(id: string): Conversation | undefined {
    const conversation = this.records.get(id);
    return conversation && conversation.messages.length > 0 ? conversation : undefined;
  }

  /** The Conversation to continue: a stored one, or a fresh one for a null id. Undefined for an id that is not there. */
  open(id: string | null): Conversation | undefined {
    return id === null ? this.create() : this.records.get(id);
  }

  /** Newest first. */
  list(): ConversationSummary[] {
    this.prune();
    return [...this.records.values()]
      .filter((c) => c.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messages: c.messages.length }));
  }

  async delete(id: string): Promise<boolean> {
    const had = this.records.delete(id);
    if (had) await this.save();
    return had;
  }

  /** Sets a pending Proposal's state to what the Owner or the page decided. Only a pending one changes. */
  decide(id: string, messageId: number, status: ProposalState): "ok" | "missing" | "settled" {
    const proposal = this.get(id)?.messages.find((m) => m.id === messageId)?.proposal;
    if (!proposal) return "missing";
    if (proposal.status === status) return "ok";
    if (proposal.status !== "pending") return "settled";
    proposal.status = status;
    return "ok";
  }

  /** Removes Conversations 30 days after their last turn, empty ones, and the oldest beyond the cap. */
  prune(keep?: string): void {
    const oldest = this.now() - CONVERSATION_RETENTION_MS;
    for (const [id, c] of this.records) if (id !== keep && (c.updatedAt < oldest || (c.messages.length === 0 && c.createdAt < oldest))) this.records.delete(id);
    const excess = this.records.size - MAX_CONVERSATIONS;
    if (excess > 0) {
      const byAge = [...this.records.values()].filter((c) => c.id !== keep).sort((a, b) => a.updatedAt - b.updatedAt);
      for (const c of byAge.slice(0, excess)) this.records.delete(c.id);
    }
  }
}

function isConversation(value: unknown): value is Conversation {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    isNumber(value.createdAt) &&
    isNumber(value.updatedAt) &&
    Array.isArray(value.messages) &&
    value.messages.every((m) => isRecord(m) && isNumber(m.id) && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") &&
    isRecord(value.usage) &&
    isRecord(value.numbering)
  );
}
