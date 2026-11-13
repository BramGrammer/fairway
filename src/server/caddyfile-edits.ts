/**
 * The Assistant's one tool: targeted edits to the Caddyfile text. Pure: it applies a list of replacements to a text
 * and says why one does not apply, in words the model can act on. The text it works on is the masked one.
 */
import type { ChatTool } from "./ai-endpoint.js";

export const EDIT_TOOL_NAME = "edit_caddyfile";

export const EDIT_TOOL: ChatTool = {
  name: EDIT_TOOL_NAME,
  description:
    "Changes the Caddyfile in the Owner's editor by replacing text. The edits are applied in order. Each old_text must occur exactly once in the Caddyfile as it is at that point, so include enough surrounding lines to be unique. An edit with an empty old_text appends new_text at the end of the Caddyfile, which is how to add a new Site. Nothing is saved or deployed: the Owner reviews the difference and decides.",
  parameters: {
    type: "object",
    properties: {
      edits: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            old_text: { type: "string", description: "The exact text to replace, once in the Caddyfile. Empty to append new_text at the end." },
            new_text: { type: "string", description: "The text that replaces it. Empty to delete old_text." },
          },
          required: ["old_text", "new_text"],
        },
      },
    },
    required: ["edits"],
  },
};

export interface TextEdit {
  oldText: string;
  newText: string;
}

export type EditsResult = { ok: true; text: string } | { ok: false; error: string };

/** Reads the arguments of a tool call as the model wrote them. */
export function parseEdits(argumentsText: string): { ok: true; edits: TextEdit[] } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(argumentsText);
  } catch {
    return { ok: false, error: "The arguments were not valid JSON. Call the tool again with {\"edits\": [{\"old_text\": ..., \"new_text\": ...}]}." };
  }
  const list = (json as { edits?: unknown } | null)?.edits;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: "Send a non-empty list of edits, each with old_text and new_text." };
  const edits: TextEdit[] = [];
  for (const [i, item] of list.entries()) {
    const { old_text, new_text } = (item ?? {}) as { old_text?: unknown; new_text?: unknown };
    if (typeof old_text !== "string" || typeof new_text !== "string") return { ok: false, error: `Edit ${i + 1} needs old_text and new_text, both as text.` };
    edits.push({ oldText: old_text, newText: new_text });
  }
  return { ok: true, edits };
}

function occurrences(text: string, part: string): number {
  let count = 0;
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + part.length)) count++;
  return count;
}

function append(text: string, addition: string): string {
  if (text === "") return addition;
  const gap = text.endsWith("\n\n") || addition.startsWith("\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return text + gap + addition + (addition.endsWith("\n") ? "" : "\n");
}

/** Applies the edits in order. All or nothing: if one does not apply, nothing of this call does, and the error names it. */
export function applyEdits(text: string, edits: TextEdit[]): EditsResult {
  let out = text;
  for (const [i, edit] of edits.entries()) {
    const label = `Edit ${i + 1}`;
    if (edit.oldText === "") {
      if (edit.newText === "") return { ok: false, error: `${label} is empty: give an old_text to replace, or a new_text to append. Nothing was changed.` };
      out = append(out, edit.newText);
      continue;
    }
    const count = occurrences(out, edit.oldText);
    if (count === 0) return { ok: false, error: `${label} does not apply: its old_text was not found in the Caddyfile (it must match exactly, including tabs and line breaks). Nothing was changed by this call.` };
    if (count > 1) return { ok: false, error: `${label} does not apply: its old_text occurs ${count} times. Include more surrounding lines so it occurs once. Nothing was changed by this call.` };
    const at = out.indexOf(edit.oldText);
    out = out.slice(0, at) + edit.newText + out.slice(at + edit.oldText.length);
  }
  return { ok: true, text: out };
}
