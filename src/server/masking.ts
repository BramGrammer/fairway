/**
 * Masking: what the Assistant is sent instead of a secret, and the way back. Every value `findSecrets` recognises is
 * replaced by a placeholder, the same value always by the same one, so the model can talk about "the token at
 * `__FAIRWAY_SECRET_1__`" and leave it exactly as it is (ADR 0008). Proposals put the values back with `restoreSecrets`.
 *
 * Without a Conversation the placeholders are numbered in the order the values first appear in the Caddyfile. A
 * Conversation passes a `Numbering`, so a value keeps its number for the whole Conversation, whatever the editor holds
 * on a later turn. The values themselves are never stored, only keyed hashes of them; the mapping back lives in server
 * memory for the turn and is never sent to the model.
 */
import { findSecrets, type Secret, type SecretKind } from "./secrets.js";

/** Letters, digits and underscores only, so it cannot be read as Caddyfile syntax or as a `{placeholder}`. */
const PLACEHOLDER = /__FAIRWAY_SECRET_(\d+)__/g;

/** Shorter values are not replaced inside other text (a Finding's message), where they would mangle ordinary words. */
const MIN_LENGTH_IN_PROSE = 4;

export interface MaskedSecret {
  placeholder: string;
  /** The real value. Server memory only. */
  value: string;
  kind: SecretKind;
  /** Safe to show the model: the header name or DNS setting, never the value. */
  label?: string;
}

export interface Masking {
  /** The Caddyfile with every recognised secret value replaced by its placeholder. */
  text: string;
  secrets: MaskedSecret[];
  /** The pending Proposal's text, masked the same way, when a turn revises one. Its secrets are in `secrets` too. */
  pending?: string;
}

/**
 * Keeps a placeholder's number for the whole Conversation: `numbers` maps a keyed hash of a secret value to its
 * number, and is filled in as new values appear. The values themselves are never kept, only their hashes.
 */
export interface Numbering {
  numbers: Record<string, number>;
  /** A keyed hash (HMAC) of a secret value. */
  key: (value: string) => string;
}

export const placeholderFor = (n: number) => `__FAIRWAY_SECRET_${n}__`;

/**
 * Replaces each recognised secret in the Caddyfile text with a stable placeholder. With a `numbering` a value keeps
 * the number it has had in the Conversation and a new value gets the next free one; without, they follow the order
 * of first appearance in the text.
 */
export function maskCaddyfile(text: string, found: Secret[] = findSecrets(text), numbering?: Numbering): Masking {
  const secrets: MaskedSecret[] = [];
  const byValue = new Map<string, MaskedSecret>();
  const numberFor = (value: string): number => {
    if (!numbering) return secrets.length + 1;
    const key = numbering.key(value);
    let n = numbering.numbers[key];
    if (n === undefined) {
      n = Math.max(0, ...Object.values(numbering.numbers)) + 1;
      numbering.numbers[key] = n;
    }
    return n;
  };
  let out = "";
  let at = 0;
  for (const range of [...found].sort((a, b) => a.from - b.from)) {
    if (range.from < at || range.to <= range.from) continue;
    const value = text.slice(range.from, range.to);
    let entry = byValue.get(value);
    if (!entry) {
      entry = { placeholder: placeholderFor(numberFor(value)), value, kind: range.kind, ...(range.label !== undefined && { label: range.label }) };
      byValue.set(value, entry);
      secrets.push(entry);
    }
    out += text.slice(at, range.from) + entry.placeholder;
    at = range.to;
  }
  return { text: out + text.slice(at), secrets };
}

/**
 * Masks the editor text and, when a Proposal is pending, that text too, with one numbering. The secrets of both are
 * known to the result, so the pending text can be restored later.
 */
export function maskWithPending(text: string, pending: string | null, numbering?: Numbering): Masking {
  const masking = maskCaddyfile(text, undefined, numbering);
  if (pending === null) return masking;
  const other = maskCaddyfile(pending, undefined, numbering);
  const known = new Set(masking.secrets.map((s) => s.placeholder));
  return { ...masking, pending: other.text, secrets: [...masking.secrets, ...other.secrets.filter((s) => !known.has(s.placeholder))] };
}

/** Masks the known secret values in any other text, such as a Finding's message that quotes the line. */
export function maskKnown(masking: Masking, text: string): string {
  let out = text;
  for (const secret of [...masking.secrets].sort((a, b) => b.value.length - a.value.length)) {
    if (secret.value.length >= MIN_LENGTH_IN_PROSE) out = out.split(secret.value).join(secret.placeholder);
  }
  return out;
}

/** Puts the real values back for every placeholder of this masking. A placeholder it does not know is left as it is. */
export function restoreSecrets(masking: Masking, text: string): string {
  const byPlaceholder = new Map(masking.secrets.map((s) => [s.placeholder, s.value]));
  return text.replace(PLACEHOLDER, (placeholder) => byPlaceholder.get(placeholder) ?? placeholder);
}
