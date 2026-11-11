/**
 * The Owner's alert settings. The environment gives the defaults; whatever the Owner changes in the
 * interface is kept in `alert-settings.json` and wins, until it is reset.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_POLICY, TIMING_KEYS, TIMING_LIMITS, TRIGGER_KEYS, type AlertPolicy, type TimingKey, type TriggerKey } from "./alert-policy.js";
import { NtfySender, type NtfyTarget } from "./alerts.js";

const FILE_VERSION = 1;
const MAX_SAVED_TOPICS = 10;

export interface SavedTopic {
  id: string;
  name: string;
  url: string;
  token?: string;
  enabled: boolean;
}

interface SavedSettings {
  version: number;
  topics: SavedTopic[];
  /** Topics from the environment that the Owner switched off. */
  disabledEnvTopics: string[];
  /** The empty string means "no link", which is different from "use the environment's". */
  publicUrl?: string;
  triggers: Partial<Record<TriggerKey, boolean>>;
  timing: Partial<Record<TimingKey, number>>;
}

/** What the environment provides. */
export interface AlertEnv {
  ntfyUrls: string[];
  ntfyToken: string | null;
  publicUrl: string | null;
}

export interface EffectiveTopic {
  id: string;
  name: string;
  url: string;
  token: string | null;
  enabled: boolean;
  source: "env" | "saved";
}

export interface EffectiveSettings {
  topics: EffectiveTopic[];
  publicUrl: string | null;
  policy: AlertPolicy;
}

export interface SettingsView {
  topics: Array<{ id: string; name: string; source: "env" | "saved"; enabled: boolean; hasToken: boolean; host?: string }>;
  publicUrl: { value: string | null; envDefault: string | null; overridden: boolean };
  triggers: Record<TriggerKey, { value: boolean; overridden: boolean }>;
  timing: Record<TimingKey, { value: number; default: number; overridden: boolean; min: number; max: number }>;
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface Patch {
  triggers?: Partial<Record<TriggerKey, boolean | null>>;
  timing?: Partial<Record<TimingKey, number | null>>;
  /** A string overrides, the empty string means no link, null goes back to the environment's. */
  publicUrl?: string | null;
}

export interface TopicPatch {
  name?: string;
  url?: string;
  /** A string replaces the token, null removes it. */
  token?: string | null;
  enabled?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function validUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const envTopicId = (url: string) => `env:${createHash("sha256").update(url).digest("hex").slice(0, 8)}`;

const empty = (): SavedSettings => ({ version: FILE_VERSION, topics: [], disabledEnvTopics: [], triggers: {}, timing: {} });

export class AlertSettings {
  private saved: SavedSettings = empty();
  private listeners: Array<() => void> = [];

  constructor(
    private readonly env: AlertEnv,
    private readonly file?: string,
  ) {}

  /** Called after every change, with the new effective settings available from `effective()`. */
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
    const next = empty();
    if (Array.isArray(data.topics)) {
      for (const topic of data.topics) {
        if (isRecord(topic) && typeof topic.id === "string" && typeof topic.name === "string" && validUrl(topic.url) && typeof topic.enabled === "boolean") {
          next.topics.push({ id: topic.id, name: topic.name, url: topic.url, enabled: topic.enabled, ...(typeof topic.token === "string" && topic.token && { token: topic.token }) });
        }
      }
    }
    if (Array.isArray(data.disabledEnvTopics)) next.disabledEnvTopics = data.disabledEnvTopics.filter((id): id is string => typeof id === "string");
    if (typeof data.publicUrl === "string" && (data.publicUrl === "" || validUrl(data.publicUrl))) next.publicUrl = data.publicUrl;
    if (isRecord(data.triggers)) for (const key of TRIGGER_KEYS) if (typeof data.triggers[key] === "boolean") next.triggers[key] = data.triggers[key];
    if (isRecord(data.timing)) {
      for (const key of TIMING_KEYS) {
        const value = data.timing[key];
        if (typeof value === "number" && Number.isInteger(value) && value >= TIMING_LIMITS[key].min && value <= TIMING_LIMITS[key].max) next.timing[key] = value;
      }
    }
    this.saved = next;
  }

  /** The settings in force: the environment's, with the Owner's changes on top. */
  effective(): EffectiveSettings {
    const topics: EffectiveTopic[] = this.env.ntfyUrls.map((url, index) => {
      const id = envTopicId(url);
      return {
        id,
        name: this.env.ntfyUrls.length > 1 ? `ntfy topic ${index + 1}` : "ntfy topic",
        url,
        token: this.env.ntfyToken,
        enabled: !this.saved.disabledEnvTopics.includes(id),
        source: "env" as const,
      };
    });
    for (const topic of this.saved.topics) topics.push({ id: topic.id, name: topic.name, url: topic.url, token: topic.token ?? null, enabled: topic.enabled, source: "saved" });

    const policy: AlertPolicy = {
      ...DEFAULT_POLICY,
      triggers: { ...DEFAULT_POLICY.triggers, ...this.saved.triggers },
      ...this.saved.timing,
    };
    const publicUrl = this.saved.publicUrl !== undefined ? this.saved.publicUrl || null : this.env.publicUrl;
    return { topics, publicUrl, policy };
  }

  /** What the interface may see. Addresses and tokens are never included; `showHosts` adds each address's host name. */
  view(showHosts: boolean): SettingsView {
    const { topics, publicUrl, policy } = this.effective();
    const triggers = {} as SettingsView["triggers"];
    for (const key of TRIGGER_KEYS) triggers[key] = { value: policy.triggers[key], overridden: this.saved.triggers[key] !== undefined };
    const timing = {} as SettingsView["timing"];
    for (const key of TIMING_KEYS) timing[key] = { value: policy[key], default: DEFAULT_POLICY[key], overridden: this.saved.timing[key] !== undefined, ...TIMING_LIMITS[key] };
    return {
      topics: topics.map((topic) => ({
        id: topic.id,
        name: topic.name,
        source: topic.source,
        enabled: topic.enabled,
        hasToken: topic.token !== null,
        ...(showHosts && { host: new URL(topic.url).host }),
      })),
      publicUrl: { value: publicUrl, envDefault: this.env.publicUrl, overridden: this.saved.publicUrl !== undefined },
      triggers,
      timing,
    };
  }

  /** A sender for the enabled topics, or null when there are none. */
  sender(): NtfySender | null {
    const targets = this.effective().topics.filter((topic) => topic.enabled).map((topic): NtfyTarget => ({ url: topic.url, token: topic.token }));
    return targets.length > 0 ? new NtfySender(targets) : null;
  }

  /** A sender for one topic, enabled or not, for its test button. */
  senderFor(id: string): NtfySender | null {
    const topic = this.effective().topics.find((candidate) => candidate.id === id);
    return topic ? new NtfySender([{ url: topic.url, token: topic.token }]) : null;
  }

  async patch(patch: Patch): Promise<Result> {
    const next = structuredClone(this.saved);
    for (const [key, value] of Object.entries(patch.triggers ?? {})) {
      if (!(TRIGGER_KEYS as readonly string[]).includes(key)) return { ok: false, error: `Unknown setting: ${key}` };
      if (value === null) delete next.triggers[key as TriggerKey];
      else if (typeof value === "boolean") next.triggers[key as TriggerKey] = value;
      else return { ok: false, error: `${key} must be true, false or null.` };
    }
    for (const [key, value] of Object.entries(patch.timing ?? {})) {
      if (!(TIMING_KEYS as string[]).includes(key)) return { ok: false, error: `Unknown setting: ${key}` };
      const limits = TIMING_LIMITS[key as TimingKey];
      if (value === null) delete next.timing[key as TimingKey];
      else if (typeof value === "number" && Number.isInteger(value) && value >= limits.min && value <= limits.max) next.timing[key as TimingKey] = value;
      else return { ok: false, error: `${key} must be a whole number from ${limits.min} to ${limits.max}.` };
    }
    if (patch.publicUrl !== undefined) {
      if (patch.publicUrl === null) delete next.publicUrl;
      else if (patch.publicUrl === "" || validUrl(patch.publicUrl)) next.publicUrl = patch.publicUrl;
      else return { ok: false, error: "The public address must start with http:// or https://." };
    }
    return this.commit(next);
  }

  async addTopic(input: { name: string; url: string; token?: string | null }): Promise<Result<{ id: string }>> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 60) return { ok: false, error: "Give the topic a name of up to 60 characters." };
    if (!validUrl(input.url)) return { ok: false, error: "The topic address must start with http:// or https://." };
    if (input.token != null && (typeof input.token !== "string" || input.token.length > 500)) return { ok: false, error: "The token is too long." };
    if (this.saved.topics.length >= MAX_SAVED_TOPICS) return { ok: false, error: `At most ${MAX_SAVED_TOPICS} topics can be added.` };
    const next = structuredClone(this.saved);
    const id = `t_${randomBytes(4).toString("hex")}`;
    next.topics.push({ id, name, url: input.url, enabled: true, ...(input.token && { token: input.token }) });
    const result = await this.commit(next);
    return result.ok ? { ok: true, id } : result;
  }

  async updateTopic(id: string, patch: TopicPatch): Promise<Result> {
    const next = structuredClone(this.saved);
    const target = next.topics.find((topic) => topic.id === id);
    if (!target) {
      // A topic from the environment can only be switched on and off.
      const env = this.effective().topics.find((topic) => topic.id === id && topic.source === "env");
      if (!env) return { ok: false, error: "No such topic." };
      if (patch.name !== undefined || patch.url !== undefined || patch.token !== undefined) return { ok: false, error: "A topic from the environment can only be switched on or off." };
      if (typeof patch.enabled !== "boolean") return { ok: false, error: "Nothing to change." };
      next.disabledEnvTopics = next.disabledEnvTopics.filter((other) => other !== id);
      if (!patch.enabled) next.disabledEnvTopics.push(id);
      return this.commit(next);
    }
    if (patch.name !== undefined) {
      const name = typeof patch.name === "string" ? patch.name.trim() : "";
      if (!name || name.length > 60) return { ok: false, error: "Give the topic a name of up to 60 characters." };
      target.name = name;
    }
    if (patch.url !== undefined) {
      if (!validUrl(patch.url)) return { ok: false, error: "The topic address must start with http:// or https://." };
      target.url = patch.url;
    }
    if (patch.token !== undefined) {
      if (patch.token === null || patch.token === "") delete target.token;
      else if (typeof patch.token === "string" && patch.token.length <= 500) target.token = patch.token;
      else return { ok: false, error: "The token is too long." };
    }
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean") return { ok: false, error: "enabled must be true or false." };
      target.enabled = patch.enabled;
    }
    return this.commit(next);
  }

  async removeTopic(id: string): Promise<Result> {
    if (!this.saved.topics.some((topic) => topic.id === id)) {
      return { ok: false, error: this.effective().topics.some((topic) => topic.id === id) ? "A topic from the environment cannot be removed; switch it off instead." : "No such topic." };
    }
    const next = structuredClone(this.saved);
    next.topics = next.topics.filter((topic) => topic.id !== id);
    return this.commit(next);
  }

  private async commit(next: SavedSettings): Promise<Result> {
    const previous = this.saved;
    this.saved = next;
    try {
      await this.write();
    } catch {
      this.saved = previous;
      return { ok: false, error: "Could not save the settings." };
    }
    for (const listener of this.listeners) listener();
    return { ok: true };
  }

  private async write(): Promise<void> {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.saved), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
