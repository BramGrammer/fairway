/**
 * The Owner's model endpoint settings. The environment gives the defaults; whatever the Owner changes in the
 * interface is kept in `ai-settings.json` and wins, until it is reset (ADR 0007). The key is write-only. Each task
 * (the Assistant, Reviews) has its own model.
 */

import { readFile } from "node:fs/promises";
import { DEFAULT_AI_BASE_URL, normalizeBaseUrl, type AiEndpoint } from "./ai-endpoint.js";
import { isRecord, writeJsonAtomic } from "./json-file.js";

const FILE_VERSION = 1;
const MAX_KEY_LENGTH = 512;
const MAX_MODEL_LENGTH = 200;

export type AiTask = "assistant" | "review";
export const AI_TASKS: readonly AiTask[] = ["assistant", "review"];
const MODEL_FIELD = { assistant: "assistantModel", review: "reviewModel" } as const;

/** How often a Review runs by itself (ADR 0009). */
export const REVIEW_INTERVALS = ["off", "6h", "12h", "24h", "weekly"] as const;
export type ReviewInterval = (typeof REVIEW_INTERVALS)[number];
export const DEFAULT_REVIEW_INTERVAL: ReviewInterval = "24h";
/** The time between two Reviews; null when they do not run by themselves. */
export const REVIEW_INTERVAL_MS: Record<ReviewInterval, number | null> = { off: null, "6h": 6 * 3_600_000, "12h": 12 * 3_600_000, "24h": 24 * 3_600_000, weekly: 7 * 24 * 3_600_000 };

/** An interval as it is kept; null when the text is not one of them. */
export function normalizeInterval(text: unknown): ReviewInterval | null {
  if (typeof text !== "string") return null;
  const value = text.trim().toLowerCase();
  return REVIEW_INTERVALS.find((interval) => interval === value) ?? null;
}

/** What the Owner's model costs, in dollars per million tokens, to approximate the cost of a Conversation. */
export interface AiPrice {
  input: number;
  output: number;
}

const MAX_PRICE = 100_000;

/** A price as it is kept: two finite amounts, not negative and not absurd. Null when it is not usable. */
export function normalizePrice(value: unknown): AiPrice | null {
  if (!isRecord(value)) return null;
  const { input, output } = value;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX_PRICE;
  return ok(input) && ok(output) ? { input, output } : null;
}

export interface AiEnv {
  baseUrl: string | null;
  apiKey: string | null;
  assistantModel?: string | null;
  reviewModel?: string | null;
  reviewInterval?: string | null;
}

interface SavedSettings {
  version: number;
  baseUrl?: string;
  apiKey?: string;
  assistantModel?: string;
  reviewModel?: string;
  reviewInterval?: ReviewInterval;
  assistantPrice?: AiPrice;
}

/** A change; null puts a field back to the environment's value. */
export interface AiPatch {
  baseUrl?: string | null;
  apiKey?: string | null;
  assistantModel?: string | null;
  reviewModel?: string | null;
  reviewInterval?: string | null;
  assistantPrice?: AiPrice | null;
}

export interface ModelView {
  /** Null when no model is chosen. */
  value: string | null;
  default: string | null;
  overridden: boolean;
}

export interface AiSettingsView {
  baseUrl: { value: string; default: string; overridden: boolean };
  /** Only whether a key is set, and where it comes from. The key itself never leaves the server. */
  apiKey: { set: boolean; source: "env" | "saved" | null; overridden: boolean };
  assistantModel: ModelView;
  reviewModel: ModelView;
  reviewInterval: { value: ReviewInterval; default: ReviewInterval; overridden: boolean };
  /** What the Assistant's model costs per million tokens, when the Owner has said; null otherwise. */
  assistantPrice: AiPrice | null;
  /** Per task: address and model are set. A key is optional, since local servers need none. */
  ready: Record<AiTask, boolean>;
}

/** A model name as it is kept: one piece of text, not too long. Null when it is not usable. */
export function normalizeModel(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const value = text.trim();
  return value && value.length <= MAX_MODEL_LENGTH && !/[\s\p{C}]/u.test(value) ? value : null;
}

export type AiResult = { ok: true } | { ok: false; error: string };

export class AiSettings {
  private saved: SavedSettings = { version: FILE_VERSION };
  private listeners: Array<() => void> = [];

  constructor(
    private readonly env: AiEnv,
    private readonly file?: string,
  ) {}

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  async load(): Promise<void> {
    if (!this.file) return;
    let data: unknown;
    try {
      data = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      return;
    }
    if (!isRecord(data) || data.version !== FILE_VERSION) return;
    const next: SavedSettings = { version: FILE_VERSION };
    if (typeof data.baseUrl === "string" && normalizeBaseUrl(data.baseUrl)) next.baseUrl = data.baseUrl;
    if (typeof data.apiKey === "string" && data.apiKey) next.apiKey = data.apiKey;
    for (const task of AI_TASKS) {
      const field = MODEL_FIELD[task];
      const model = normalizeModel(data[field]);
      if (model) next[field] = model;
    }
    const interval = normalizeInterval(data.reviewInterval);
    if (interval) next.reviewInterval = interval;
    const price = normalizePrice(data.assistantPrice);
    if (price) next.assistantPrice = price;
    this.saved = next;
  }

  private defaultInterval(): ReviewInterval {
    return normalizeInterval(this.env.reviewInterval) ?? DEFAULT_REVIEW_INTERVAL;
  }

  /** How often a Review runs by itself. */
  reviewInterval(): ReviewInterval {
    return this.saved.reviewInterval ?? this.defaultInterval();
  }

  private defaultModel(task: AiTask): string | null {
    return normalizeModel(this.env[MODEL_FIELD[task]]);
  }

  /** The model chosen for a task, or null. */
  model(task: AiTask): string | null {
    return this.saved[MODEL_FIELD[task]] ?? this.defaultModel(task);
  }

  /** Whether a task can be offered: an address (always there) and a model. */
  ready(): Record<AiTask, boolean> {
    return { assistant: this.model("assistant") !== null, review: this.model("review") !== null };
  }

  private modelView(task: AiTask): ModelView {
    return { value: this.model(task), default: this.defaultModel(task), overridden: this.saved[MODEL_FIELD[task]] !== undefined };
  }

  private defaultBaseUrl(): string {
    return (this.env.baseUrl && normalizeBaseUrl(this.env.baseUrl)) || DEFAULT_AI_BASE_URL;
  }

  /** The endpoint in force: the environment's, with the Owner's changes on top. */
  effective(): AiEndpoint {
    return { baseUrl: this.saved.baseUrl ?? this.defaultBaseUrl(), apiKey: this.saved.apiKey ?? this.env.apiKey };
  }

  view(): AiSettingsView {
    const key = this.effective().apiKey;
    return {
      baseUrl: { value: this.effective().baseUrl, default: this.defaultBaseUrl(), overridden: this.saved.baseUrl !== undefined },
      apiKey: { set: key !== null, source: key === null ? null : this.saved.apiKey !== undefined ? "saved" : "env", overridden: this.saved.apiKey !== undefined },
      assistantModel: this.modelView("assistant"),
      reviewModel: this.modelView("review"),
      reviewInterval: { value: this.reviewInterval(), default: this.defaultInterval(), overridden: this.saved.reviewInterval !== undefined },
      assistantPrice: this.saved.assistantPrice ?? null,
      ready: this.ready(),
    };
  }

  async patch(patch: AiPatch): Promise<AiResult> {
    const next: SavedSettings = { ...this.saved };
    if (patch.baseUrl !== undefined) {
      if (patch.baseUrl === null) delete next.baseUrl;
      else {
        const url = typeof patch.baseUrl === "string" ? normalizeBaseUrl(patch.baseUrl) : null;
        if (!url) return { ok: false, error: "Enter a full address starting with http:// or https://, without a login or query in it." };
        next.baseUrl = url;
      }
    }
    if (patch.apiKey !== undefined) {
      if (patch.apiKey === null) delete next.apiKey;
      else {
        const key = typeof patch.apiKey === "string" ? patch.apiKey.trim() : "";
        if (!key || key.length > MAX_KEY_LENGTH || /\s/.test(key)) return { ok: false, error: "Enter the key as one piece of text, without spaces." };
        next.apiKey = key;
      }
    }
    for (const task of AI_TASKS) {
      const field = MODEL_FIELD[task];
      if (patch[field] === undefined) continue;
      if (patch[field] === null) delete next[field];
      else {
        const model = normalizeModel(patch[field]);
        if (!model) return { ok: false, error: "Enter the model name as one piece of text, without spaces." };
        next[field] = model;
      }
    }
    if (patch.reviewInterval !== undefined) {
      if (patch.reviewInterval === null) delete next.reviewInterval;
      else {
        const interval = normalizeInterval(patch.reviewInterval);
        if (!interval) return { ok: false, error: "Choose off, 6 hours, 12 hours, 24 hours or weekly." };
        next.reviewInterval = interval;
      }
    }
    if (patch.assistantPrice !== undefined) {
      if (patch.assistantPrice === null) delete next.assistantPrice;
      else {
        const price = normalizePrice(patch.assistantPrice);
        if (!price) return { ok: false, error: "Enter both prices as numbers of dollars per million tokens, zero or more." };
        next.assistantPrice = price;
      }
    }
    const previous = this.saved;
    this.saved = next;
    try {
      if (this.file) await writeJsonAtomic(this.file, this.saved, 0o600);
    } catch {
      this.saved = previous;
      return { ok: false, error: "Could not save the settings." };
    }
    for (const listener of this.listeners) listener();
    return { ok: true };
  }
}
