/**
 * The Owner's alert settings. The environment gives the defaults; whatever the Owner changes in the
 * interface is kept in `alert-settings.json` and wins, until it is reset.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DEFAULT_POLICY, TIMING_KEYS, TIMING_LIMITS, TRIGGER_KEYS, type AlertPolicy, type TimingKey, type TriggerKey } from "./alert-policy.js";
import { NtfySender, type NtfyTarget } from "./alerts.js";
import { subjectKind, subjectName, type AlertScope } from "./events.js";
import { isRecord, writeJsonAtomic } from "./json-file.js";

const FILE_VERSION = 1;
const MAX_SAVED_TOPICS = 10;
const MAX_HOSTS = 500;
const MAX_SNOOZE_MIN = 7 * 24 * 60;

/** What can send an Alert for a host. */
export const HOST_KINDS = ["cert", "host", "upstream"] as const;
export type HostKind = (typeof HOST_KINDS)[number];

/** Alerts for one host. A host sends none until the Owner switches it on. */
export interface HostAlerts {
  enabled: boolean;
  kinds: Record<HostKind, boolean>;
  /** Alerts are held back until this time (ms). */
  snoozedUntil?: number;
}

export interface HostPatch {
  enabled?: boolean;
  kinds?: Partial<Record<HostKind, boolean>>;
  /** Hold alerts back for this many minutes; null ends a snooze. */
  snoozeMinutes?: number | null;
}

/** Which hosts use which upstream, from the running config. */
export interface RouteMap {
  upstreamHosts: Map<string, string[]>;
}

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
  hosts: Array<[string, HostAlerts]>;
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
  /** Only hosts the Owner has set something for; every other host sends no Alerts. */
  hosts: Record<string, { enabled: boolean; kinds: Record<HostKind, boolean>; snoozedUntil: number | null }>;
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface Patch {
  triggers?: Partial<Record<TriggerKey, boolean | null>>;
  timing?: Partial<Record<TimingKey, number | null>>;
  /** A string overrides, the empty string means no link, null goes back to the environment's. */
  publicUrl?: string | null;
  /** A host's alert settings; null forgets the host. */
  hosts?: Record<string, HostPatch | null>;
}

export interface TopicPatch {
  name?: string;
  url?: string;
  /** A string replaces the token, null removes it. */
  token?: string | null;
  enabled?: boolean;
}

const validTiming = (key: TimingKey, value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= TIMING_LIMITS[key].min && value <= TIMING_LIMITS[key].max;

const defaultKinds = (): Record<HostKind, boolean> => ({ cert: true, host: true, upstream: true });

const NAME_ERROR = "Give the topic a name of up to 60 characters.";
const TOKEN_ERROR = "The token is too long.";
const URL_ERROR = "The topic address must start with http:// or https://.";
const cleanName = (value: unknown): string | null => {
  const name = typeof value === "string" ? value.trim() : "";
  return name && name.length <= 60 ? name : null;
};
const validToken = (value: unknown): value is string => typeof value === "string" && value.length <= 500;

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

const empty = (): SavedSettings => ({ version: FILE_VERSION, topics: [], disabledEnvTopics: [], hosts: [], triggers: {}, timing: {} });

const validHostName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 253 && !["__proto__", "constructor", "prototype"].includes(value);

const quiet = (host: HostAlerts) => !host.enabled && host.snoozedUntil === undefined && HOST_KINDS.every((kind) => host.kinds[kind]);

export class AlertSettings {
  private saved: SavedSettings = empty();
  private listeners: Array<() => void> = [];
  private hostLookup: Map<string, HostAlerts> | null = null;

  constructor(
    private readonly env: AlertEnv,
    private readonly file?: string,
    private readonly now: () => number = Date.now,
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
    if (Array.isArray(data.hosts)) {
      for (const entry of data.hosts.slice(0, MAX_HOSTS)) {
        if (!Array.isArray(entry) || !validHostName(entry[0]) || !isRecord(entry[1]) || typeof entry[1].enabled !== "boolean" || !isRecord(entry[1].kinds)) continue;
        const kinds = {} as Record<HostKind, boolean>;
        for (const kind of HOST_KINDS) kinds[kind] = typeof entry[1].kinds[kind] === "boolean" ? (entry[1].kinds[kind] as boolean) : true;
        next.hosts.push([entry[0], { enabled: entry[1].enabled, kinds, ...(typeof entry[1].snoozedUntil === "number" && { snoozedUntil: entry[1].snoozedUntil }) }]);
      }
    }
    if (isRecord(data.triggers)) for (const key of TRIGGER_KEYS) if (typeof data.triggers[key] === "boolean") next.triggers[key] = data.triggers[key];
    if (isRecord(data.timing)) {
      for (const key of TIMING_KEYS) {
        const value = data.timing[key];
        if (validTiming(key, value)) next.timing[key] = value;
      }
    }
    this.saved = next;
    this.hostLookup = null;
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
    const hosts: SettingsView["hosts"] = {};
    for (const [host, config] of this.saved.hosts) hosts[host] = { enabled: config.enabled, kinds: { ...config.kinds }, snoozedUntil: config.snoozedUntil ?? null };
    return {
      hosts,
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
      else if (validTiming(key as TimingKey, value)) next.timing[key as TimingKey] = value;
      else return { ok: false, error: `${key} must be a whole number from ${limits.min} to ${limits.max}.` };
    }
    if (patch.publicUrl !== undefined) {
      if (patch.publicUrl === null) delete next.publicUrl;
      else if (patch.publicUrl === "" || validUrl(patch.publicUrl)) next.publicUrl = patch.publicUrl;
      else return { ok: false, error: "The public address must start with http:// or https://." };
    }
    if (patch.hosts !== undefined) {
      if (typeof patch.hosts !== "object" || patch.hosts === null) return { ok: false, error: "hosts must be an object." };
      const map = new Map(next.hosts);
      for (const [host, change] of Object.entries(patch.hosts)) {
        if (!validHostName(host)) return { ok: false, error: "That is not a host name." };
        if (change === null) {
          map.delete(host);
          continue;
        }
        const failed = this.applyHostPatch(map, host, change);
        if (failed) return { ok: false, error: failed };
      }
      if (map.size > MAX_HOSTS) return { ok: false, error: `Alerts can be set for at most ${MAX_HOSTS} hosts.` };
      next.hosts = [...map];
    }
    return this.commit(next);
  }

  /** Changes one host's entry in `map`; returns a reason when the change is not allowed. */
  private applyHostPatch(map: Map<string, HostAlerts>, host: string, change: HostPatch): string | null {
    if (typeof change !== "object") return "A host's settings must be an object.";
    const current = map.get(host) ?? { enabled: false, kinds: defaultKinds() };
    const next: HostAlerts = { ...current, kinds: { ...current.kinds } };
    if (change.enabled !== undefined) {
      if (typeof change.enabled !== "boolean") return "enabled must be true or false.";
      next.enabled = change.enabled;
    }
    for (const [kind, value] of Object.entries(change.kinds ?? {})) {
      if (!(HOST_KINDS as readonly string[]).includes(kind)) return `Unknown kind: ${kind}`;
      if (typeof value !== "boolean") return `${kind} must be true or false.`;
      next.kinds[kind as HostKind] = value;
    }
    if (change.snoozeMinutes !== undefined) {
      if (change.snoozeMinutes === null) delete next.snoozedUntil;
      else if (Number.isInteger(change.snoozeMinutes) && change.snoozeMinutes >= 1 && change.snoozeMinutes <= MAX_SNOOZE_MIN) next.snoozedUntil = this.now() + change.snoozeMinutes * 60_000;
      else return `A snooze is from 1 minute to ${MAX_SNOOZE_MIN / 60 / 24} days.`;
    }
    if (quiet(next)) map.delete(host);
    else map.set(host, next);
    return null;
  }

  /**
   * Which Subjects may send an Alert: a host's Certificate, host check and upstreams only when the Owner switched
   * that host on for that kind and it is not snoozed. An upstream shared by several hosts alerts while any of them is
   * on. Caddy itself is not about a host and is left to the global switches.
   */
  scope(routes: () => RouteMap): AlertScope {
    return (subject, now) => {
      const kind = subjectKind(subject);
      if (kind === "caddy") return { send: true };
      const config = this.hostConfig();
      const alerting = (host: string, hostKind: HostKind) => {
        const entry = config.get(host);
        return entry !== undefined && entry.enabled && entry.kinds[hostKind] && (entry.snoozedUntil === undefined || entry.snoozedUntil <= now);
      };
      if (kind === "upstream") {
        const hosts = (routes().upstreamHosts.get(subject) ?? []).filter((host) => alerting(host, "upstream"));
        return { send: hosts.length > 0, hosts };
      }
      return { send: alerting(subjectName(subject), kind) };
    };
  }

  async addTopic(input: { name: string; url: string; token?: string | null }): Promise<Result<{ id: string }>> {
    const name = cleanName(input.name);
    if (!name) return { ok: false, error: NAME_ERROR };
    if (!validUrl(input.url)) return { ok: false, error: URL_ERROR };
    if (input.token != null && !validToken(input.token)) return { ok: false, error: TOKEN_ERROR };
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
      const name = cleanName(patch.name);
      if (!name) return { ok: false, error: NAME_ERROR };
      target.name = name;
    }
    if (patch.url !== undefined) {
      if (!validUrl(patch.url)) return { ok: false, error: URL_ERROR };
      target.url = patch.url;
    }
    if (patch.token !== undefined) {
      if (patch.token === null || patch.token === "") delete target.token;
      else if (validToken(patch.token)) target.token = patch.token;
      else return { ok: false, error: TOKEN_ERROR };
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

  /** The per-host settings as a lookup, rebuilt only when they change. */
  private hostConfig(): Map<string, HostAlerts> {
    this.hostLookup ??= new Map(this.saved.hosts);
    return this.hostLookup;
  }

  private async commit(next: SavedSettings): Promise<Result> {
    const previous = this.saved;
    this.saved = next;
    this.hostLookup = null;
    try {
      await this.write();
    } catch {
      this.saved = previous;
      this.hostLookup = null;
      return { ok: false, error: "Could not save the settings." };
    }
    for (const listener of this.listeners) listener();
    return { ok: true };
  }

  private async write(): Promise<void> {
    if (!this.file) return;
    await writeJsonAtomic(this.file, this.saved, 0o600);
  }
}
