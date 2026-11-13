/** The view of the model endpoint settings the server returns, and the pure helpers around it. Copied, not imported, from the server. */

export interface AiSettingsView {
  /** Without a login the address and key cannot be changed. */
  canEdit: boolean
  baseUrl: { value: string; default: string; overridden: boolean }
  apiKey: { set: boolean; source: "env" | "saved" | null; overridden: boolean }
  assistantModel: ModelView
  reviewModel: ModelView
  reviewInterval: { value: ReviewInterval; default: ReviewInterval; overridden: boolean }
  /** What the Assistant's model costs per million tokens, when the Owner has said. */
  assistantPrice: AiPrice | null
  /** Per task: address and model are set. */
  ready: { assistant: boolean; review: boolean }
}

/** Dollars per million tokens. */
export interface AiPrice {
  input: number
  output: number
}

export const REVIEW_INTERVALS = ["off", "6h", "12h", "24h", "weekly"] as const
export type ReviewInterval = (typeof REVIEW_INTERVALS)[number]

export const INTERVAL_LABELS: Record<ReviewInterval, string> = {
  off: "Off",
  "6h": "Every 6 hours",
  "12h": "Every 12 hours",
  "24h": "Every 24 hours",
  weekly: "Weekly",
}

export const describeInterval = (view: AiSettingsView["reviewInterval"]) =>
  view.overridden ? `Default ${INTERVAL_LABELS[view.default].toLowerCase()}.` : `Taken from the environment or the default: ${INTERVAL_LABELS[view.default].toLowerCase()}.`

export type AiTask = "assistant" | "review"

export interface ModelView {
  value: string | null
  default: string | null
  overridden: boolean
}

export type ModelsReply = { ok: true; models: string[] } | { ok: false; error: string }

export type ModelTestReply = { ok: true } | { ok: false; reason?: string; error: string }

export type AiSettingsReply = ({ ok: true } & AiSettingsView) | { ok: false; error: string }

export interface AiPutBody {
  baseUrl?: string | null
  apiKey?: string | null
  assistantModel?: string | null
  reviewModel?: string | null
  reviewInterval?: ReviewInterval | null
  assistantPrice?: AiPrice | null
}

/** The body for saving the Assistant's prices. Both are needed, and an empty one counts as zero only when typed as 0. */
export function priceBody(input: string, output: string): { ok: true; body: AiPutBody } | { ok: false; error: string } {
  const parse = (text: string) => (text.trim() === "" ? NaN : Number(text.trim().replace(",", ".")))
  const [i, o] = [parse(input), parse(output)]
  if (![i, o].every((n) => Number.isFinite(n) && n >= 0)) return { ok: false, error: "Enter both prices as numbers, zero or more." }
  return { ok: true, body: { assistantPrice: { input: i, output: o } } }
}

export const describePrice = (price: AiPrice | null) => (price ? "Used for the approximate cost shown on the Assistant's token indicator." : "Not set, so no cost is shown. Prices are in dollars per million tokens.")

export type AiTestReply =
  | { ok: true; models?: number }
  | { ok: false; reason?: "unreachable" | "key_refused" | "not_compatible"; error: string }

export const AI_LOGIN_REQUIRED = "Sign in is required to change the model endpoint. Set AUTH_USER and a password in the environment first."

/** The body for saving the address. Empty is refused here, since resetting is its own action. */
export function baseUrlBody(text: string): { ok: true; body: AiPutBody } | { ok: false; error: string } {
  const value = text.trim()
  if (value === "") return { ok: false, error: "Enter the endpoint address." }
  return { ok: true, body: { baseUrl: value } }
}

/** The body for saving a new key. Empty is refused: the field stays empty to keep the key, and Reset removes the saved one. */
export function apiKeyBody(text: string): { ok: true; body: AiPutBody } | { ok: false; error: string } {
  const value = text.trim()
  if (value === "") return { ok: false, error: "Enter the key." }
  return { ok: true, body: { apiKey: value } }
}

export function describeKey(view: AiSettingsView["apiKey"]): string {
  if (!view.set) return "No key is set."
  if (view.source === "env") return "A key is set in the environment. It is never shown."
  return view.overridden ? "A key is saved here. It is never shown." : "A key is set."
}

export const describeBaseUrl = (view: AiSettingsView["baseUrl"]) =>
  view.overridden ? `Default ${view.default}.` : `Taken from the environment or the default: ${view.default}.`

export const MODEL_FIELD = { assistant: "assistantModel", review: "reviewModel" } as const

/** The body for saving a task's model. Empty is refused, since resetting is its own action. */
export function modelBody(task: AiTask, text: string): { ok: true; body: AiPutBody } | { ok: false; error: string } {
  const value = text.trim()
  if (value === "") return { ok: false, error: "Enter the model name." }
  if (/\s/.test(value)) return { ok: false, error: "A model name has no spaces." }
  return { ok: true, body: { [MODEL_FIELD[task]]: value } }
}

/** The models that match what was typed, case-insensitively. Everything when nothing is typed. */
export function filterModels(models: string[], query: string): string[] {
  const q = query.trim().toLowerCase()
  return q ? models.filter((m) => m.toLowerCase().includes(q)) : models
}

export const describeModel = (view: ModelView) =>
  view.overridden ? (view.default ? `Default ${view.default}.` : "No default is set in the environment.") : view.value ? "Taken from the environment." : "No model is chosen yet."
