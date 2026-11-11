/**
 * The event log: every change of a Subject's State, plus one-shot occurrences such as a failed deploy.
 * History views read it and Alerts are sent from it (see ADR 0006).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_POLICY, type AlertPolicy } from "./alert-policy.js";
import type { AlertPayload, AlertSender } from "./alerts.js";

export type StateName = "ok" | "warning" | "down";
export type EventKind = "state" | "gap" | "removed" | "flapping" | "deploy_failed" | "external_edit" | "rollback";
export type Delivery = "sent" | "failed" | "pending";
export type SubjectKind = "caddy" | "cert" | "upstream" | "host";

export interface EventRecord {
  id: number;
  /** When it happened, in ms. For a State change that is when the new State began. */
  at: number;
  kind: EventKind;
  /** `caddy`, `cert:<host>`, `upstream:<address>` or `host:<name>`; absent for one-shot events. */
  subject?: string;
  state?: StateName;
  previous?: StateName | null;
  /** End of a Gap, in ms. */
  until?: number;
  message: string;
  /** Present only when an Alert was due for this event. */
  delivery?: Delivery;
}

export type TimelineState = StateName | "unknown";
export interface TimelineInterval {
  from: number;
  to: number;
  state: TimelineState;
}

/**
 * How long a State must hold before it counts. For Caddy and upstreams the Owner can change it, see
 * `AlertPolicy`; the other two are fixed. `host` is the synthetic check: two failures in a row at its 5 minute interval.
 */
export const DEBOUNCE_MS: Record<SubjectKind, number> = {
  caddy: 15_000,
  upstream: 60_000,
  cert: 0,
  host: 240_000,
};

export const RETENTION_MS = 30 * 24 * 3_600_000;
export const MAX_EVENTS = 2000;
/** More than this many State changes of one Subject within `FLAP_WINDOW_MS` count as flapping. */
export const FLAP_WINDOW_MS = 3_600_000;
/** A silence longer than this between two checks is recorded as a Gap. */
export const GAP_MS = 120_000;
const SAVE_MS = 60_000;
const FILE_VERSION = 1;

interface SubjectState {
  state: StateName;
  /** When this State began. */
  since: number;
  /** Alerts for this Subject are held back until it has been stable for a while. */
  muted?: boolean;
}

interface SavedEvents {
  version: number;
  lastBeat: number | null;
  nextId: number;
  subjects: Array<[string, SubjectState]>;
  events: EventRecord[];
}

export function subjectKind(subject: string): SubjectKind {
  if (subject === "caddy") return "caddy";
  const prefix = subject.slice(0, subject.indexOf(":"));
  return prefix === "cert" || prefix === "upstream" || prefix === "host" ? prefix : "host";
}

export const subjectName = (subject: string) => (subject === "caddy" ? "Caddy" : subject.slice(subject.indexOf(":") + 1));

function describe(subject: string, state: StateName, previous: StateName | null, detail?: string): string {
  const name = subjectName(subject);
  const extra = detail ? ` (${detail})` : "";
  const recovered = state === "ok" && previous !== null;
  switch (subjectKind(subject)) {
    case "caddy":
      return state === "ok" ? (recovered ? "Caddy answers again" : "Caddy answers") : `Caddy is not answering${extra}`;
    case "cert":
      return state === "ok" ? `Certificate for ${name} is fine${recovered ? " again" : ""}` : `Certificate for ${name} is ${state === "warning" ? "amber" : "red"}${extra}`;
    case "upstream":
      return state === "ok" ? `Upstream ${name} is ${recovered ? "back up" : "up"}` : `Upstream ${name} is down${extra}`;
    case "host":
      return state === "ok" ? `${name} answers${recovered ? " again" : ""}` : `${name} is not answering properly${extra}`;
  }
}

/** An upstream's message says which of the hosts that use it are alerting. */
function withHosts(subject: string, message: string, hosts: string[] | undefined): string {
  if (subjectKind(subject) !== "upstream" || !hosts || hosts.length === 0) return message;
  const shown = hosts.slice(0, 5).join(", ");
  return `${message}, used by ${shown}${hosts.length > 5 ? ` and ${hosts.length - 5} more` : ""}`;
}

const severity: Record<StateName, number> = { ok: 0, warning: 1, down: 2 };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isState = (value: unknown): value is StateName => value === "ok" || value === "warning" || value === "down";
const KINDS: EventKind[] = ["state", "gap", "removed", "flapping", "deploy_failed", "external_edit", "rollback"];

function validEvent(value: unknown): value is EventRecord {
  if (!isRecord(value)) return false;
  if (!isNumber(value.id) || !isNumber(value.at) || typeof value.message !== "string") return false;
  if (!KINDS.includes(value.kind as EventKind)) return false;
  if (value.subject !== undefined && typeof value.subject !== "string") return false;
  if (value.state !== undefined && !isState(value.state)) return false;
  if (value.previous !== undefined && value.previous !== null && !isState(value.previous)) return false;
  if (value.until !== undefined && !isNumber(value.until)) return false;
  return true;
}

function validSubject(value: unknown): value is [string, SubjectState] {
  return Array.isArray(value) && typeof value[0] === "string" && isRecord(value[1]) && isState(value[1].state) && isNumber(value[1].since);
}

/** Decides, per Subject, whether an Alert may be sent for it, and which hosts it would be about. */
export type AlertScope = (subject: string, now: number) => { send: boolean; hosts?: string[] };

export interface EventTrackerOptions {
  /** `events.json`; without it nothing is persisted. */
  file?: string;
  sender?: AlertSender | null;
  /** Base URL of Fairway for the link in an Alert. */
  publicUrl?: string | null;
  now?: () => number;
}

export class EventTracker {
  private readonly file?: string;
  private sender: AlertSender | null;
  private publicUrl: string | null;
  private policy: AlertPolicy = DEFAULT_POLICY;
  private scope: AlertScope | null = null;
  private readonly clock: () => number;
  private events: EventRecord[] = [];
  private subjects = new Map<string, SubjectState>();
  private pending = new Map<string, { state: StateName; since: number; detail?: string }>();
  private nextId = 1;
  private lastBeat: number | null = null;
  private deliveries = new Set<Promise<void>>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(options: EventTrackerOptions = {}) {
    this.file = options.file;
    this.sender = options.sender ?? null;
    this.publicUrl = options.publicUrl ?? null;
    this.clock = options.now ?? Date.now;
  }

  get alertsEnabled(): boolean {
    return this.sender !== null;
  }

  /** Changes where Alerts go, what sends one and how long things must hold, with effect from the next reading. */
  configure(settings: { sender?: AlertSender | null; publicUrl?: string | null; policy?: AlertPolicy; scope?: AlertScope | null }): void {
    if (settings.scope !== undefined) this.scope = settings.scope;
    if (settings.sender !== undefined) this.sender = settings.sender;
    if (settings.publicUrl !== undefined) this.publicUrl = settings.publicUrl;
    if (settings.policy) this.policy = settings.policy;
  }

  /** Whether this kind of Subject may send Alerts at all. Only Caddy has a global switch; hosts are chosen one by one. */
  private sends(subject: string): boolean {
    return subjectKind(subject) === "caddy" ? this.policy.triggers.caddy : true;
  }

  private holdMs(subject: string): number {
    switch (subjectKind(subject)) {
      case "caddy":
        return this.policy.caddyHoldSec * 1000;
      case "upstream":
        return this.policy.upstreamHoldSec * 1000;
      default:
        return DEBOUNCE_MS[subjectKind(subject)];
    }
  }

  /** Periodic saving; the final save happens through the shutdown hook. */
  start(): void {
    if (this.saveTimer || !this.file) return;
    this.saveTimer = setInterval(() => void this.save().catch(() => {}), SAVE_MS);
    this.saveTimer.unref();
  }

  stop(): void {
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveTimer = null;
  }

  /** Resolves when every Alert started so far has been delivered or given up on. */
  async flush(): Promise<void> {
    while (this.deliveries.size > 0) await Promise.allSettled([...this.deliveries]);
  }

  // ---- readings in ----

  /** One look at the clock; the first one after a silence longer than `GAP_MS` records a Gap. */
  beat(now = this.clock()): void {
    if (this.lastBeat !== null && now - this.lastBeat > GAP_MS) {
      this.add({ at: this.lastBeat, kind: "gap", until: now, message: "Fairway was not watching" });
      this.pending.clear();
    }
    this.lastBeat = now;
  }

  /** One reading of a Subject. A State counts once it has held for the debounce of its kind. */
  observe(subject: string, state: StateName, detail?: string, now = this.clock()): void {
    const current = this.subjects.get(subject);
    if (current?.state === state) {
      this.pending.delete(subject);
    } else {
      let candidate = this.pending.get(subject);
      if (candidate?.state !== state) {
        candidate = { state, since: now, ...(detail !== undefined && { detail }) };
        this.pending.set(subject, candidate);
      }
      const settled = now - candidate.since >= this.holdMs(subject);
      if (settled || (!current && state === "ok")) {
        this.pending.delete(subject);
        this.commit(subject, state, candidate.since, detail, now);
      }
    }
    this.releaseIfStable(subject, now);
  }

  /** Subjects of `kind` that are no longer configured stop being watched. */
  sync(kind: SubjectKind, present: Iterable<string>, now = this.clock()): void {
    const keep = new Set(present);
    for (const subject of [...this.subjects.keys()]) {
      if (subjectKind(subject) !== kind || keep.has(subject)) continue;
      this.subjects.delete(subject);
      this.pending.delete(subject);
      this.add({ at: now, kind: "removed", subject, message: `${subjectName(subject)} is no longer configured` });
    }
  }

  /** A one-shot occurrence. Whether it sends an Alert is up to the Owner; by default a rollback does not. */
  record(kind: "deploy_failed" | "external_edit" | "rollback", message: string, now = this.clock()): EventRecord {
    const event = this.add({ at: now, kind, message });
    if (this.policy.triggers[kind]) this.alert(event, { event: kind, subject: null, state: null, previous: null, since: now, message });
    return event;
  }

  /** Sends a clearly marked fake Alert and says whether it arrived. Nothing is recorded. */
  async sendTest(now = this.clock(), sender: AlertSender | null = this.sender): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!sender) return { ok: false, error: "No ntfy topic is configured." };
    try {
      await sender.send(this.payload({ event: "test", subject: null, state: null, previous: null, since: now, message: "Test alert from Fairway" }, true), { retry: false });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  // ---- reading out ----

  /** Newest first. */
  list(options: { subject?: string; limit?: number } = {}): EventRecord[] {
    const matching = options.subject === undefined ? this.events : this.events.filter((event) => event.subject === options.subject);
    return matching.toReversed().slice(0, options.limit ?? 200);
  }

  stateOf(subject: string): StateName | null {
    return this.subjects.get(subject)?.state ?? null;
  }

  /**
   * What the worst State among `subjects` was over a window. A Gap, or no knowledge yet, shows as unknown.
   * Adjacent stretches with the same State are merged.
   */
  timeline(subjects: string[], from: number, to: number): TimelineInterval[] {
    const steps = subjects.map((subject) => {
      const list: Array<{ at: number; state: StateName | null }> = [];
      for (const event of this.events) {
        if (event.subject !== subject) continue;
        if (event.kind === "state" && event.state) list.push({ at: event.at, state: event.state });
        else if (event.kind === "removed") list.push({ at: event.at, state: null });
      }
      return list.sort((a, b) => a.at - b.at);
    });
    const gaps = this.events.filter((event) => event.kind === "gap" && event.until !== undefined);

    const cuts = new Set<number>([from, to]);
    const clip = (t: number) => {
      if (t > from && t < to) cuts.add(t);
    };
    for (const list of steps) for (const step of list) clip(step.at);
    for (const gap of gaps) {
      clip(gap.at);
      clip(gap.until!);
    }
    const points = [...cuts].sort((a, b) => a - b);

    const result: TimelineInterval[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const start = points[i];
      const end = points[i + 1];
      let state: TimelineState = "unknown";
      if (!gaps.some((gap) => gap.at <= start && gap.until! >= end)) {
        for (const list of steps) {
          let at: StateName | null = null;
          for (const step of list) {
            if (step.at <= start) at = step.state;
            else break;
          }
          if (at !== null && (state === "unknown" || severity[at] > severity[state])) state = at;
        }
      }
      const last = result.at(-1);
      if (last && last.state === state) last.to = end;
      else result.push({ from: start, to: end, state });
    }
    return result;
  }

  // ---- persistence ----

  async load(): Promise<void> {
    if (!this.file) return;
    let data: unknown;
    try {
      data = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      return;
    }
    if (!isRecord(data) || data.version !== FILE_VERSION) return;
    if (!Array.isArray(data.events) || !Array.isArray(data.subjects) || !isNumber(data.nextId)) return;
    if (data.lastBeat !== null && !isNumber(data.lastBeat)) return;
    this.events = data.events.filter(validEvent);
    this.subjects = new Map(data.subjects.filter(validSubject));
    this.nextId = Math.max(data.nextId, ...this.events.map((event) => event.id + 1));
    this.lastBeat = data.lastBeat;
    // An Alert that was still being delivered when Fairway stopped is not retried.
    for (const event of this.events) if (event.delivery === "pending") event.delivery = "failed";
    this.prune();
  }

  async save(): Promise<void> {
    if (!this.file) return;
    const data: SavedEvents = {
      version: FILE_VERSION,
      lastBeat: this.lastBeat,
      nextId: this.nextId,
      subjects: [...this.subjects],
      events: this.events,
    };
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, this.file);
  }

  // ---- internals ----

  private add(event: Omit<EventRecord, "id">): EventRecord {
    const record: EventRecord = { id: this.nextId++, ...event };
    this.events.push(record);
    this.prune();
    return record;
  }

  /** Retention is counted back from the newest event, so a long quiet spell does not empty the log. */
  private prune(): void {
    const newest = this.events.reduce((latest, event) => Math.max(latest, event.until ?? event.at), 0);
    const keepFrom = newest - RETENTION_MS;
    this.events = this.events.filter((event) => (event.until ?? event.at) >= keepFrom);
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
  }

  private commit(subject: string, state: StateName, at: number, detail: string | undefined, now: number): void {
    const previous = this.subjects.get(subject)?.state ?? null;
    const message = describe(subject, state, previous, detail);
    const event = this.add({ at, kind: "state", subject, state, previous, message });
    const current: SubjectState = { state, since: at, ...(this.subjects.get(subject)?.muted && { muted: true }) };
    this.subjects.set(subject, current);

    if (state === "ok" && previous === null) return; // the first sighting of a healthy Subject is not news
    if (!this.sends(subject)) return;
    const scope = this.scope?.(subject, now) ?? { send: true };
    if (!scope.send) return;
    if (current.muted) return;

    const changes = this.events.filter((e) => e.kind === "state" && e.subject === subject && e.previous !== null && e.at > now - FLAP_WINDOW_MS).length;
    if (changes > this.policy.flapChanges) {
      current.muted = true;
      const flap = this.add({ at: now, kind: "flapping", subject, state, message: `${subjectName(subject)} keeps changing State; alerts are held until it settles` });
      if (this.policy.triggers.flapping) this.alert(flap, { event: "flapping", subject, state, previous, since: now, message: flap.message });
      return;
    }
    if (state === "ok" && !this.policy.triggers.recovery) return;
    this.alert(event, { event: "state", subject, state, previous, since: at, message: withHosts(subject, message, scope.hosts) });
  }

  /** A flapping Subject that has been stable for a while is announced once and un-muted. */
  private releaseIfStable(subject: string, now: number): void {
    const current = this.subjects.get(subject);
    if (!current?.muted || now - current.since < this.policy.flapStableMin * 60_000) return;
    current.muted = false;
    const message = `${describe(subject, current.state, null)} (settled)`;
    const event = this.add({ at: now, kind: "flapping", subject, state: current.state, message });
    if (this.policy.triggers.flapping && this.sends(subject) && (this.scope?.(subject, now) ?? { send: true }).send) {
      this.alert(event, { event: "flapping", subject, state: current.state, previous: null, since: current.since, message });
    }
  }

  private payload(base: Omit<AlertPayload, "since" | "link"> & { since: number }, test = false): AlertPayload {
    return {
      ...base,
      since: new Date(base.since).toISOString(),
      ...(this.publicUrl && { link: this.publicUrl }),
      ...(test && { test: true }),
    } as AlertPayload;
  }

  private alert(event: EventRecord, base: Omit<AlertPayload, "since" | "link"> & { since: number }): void {
    if (!this.sender) return;
    event.delivery = "pending";
    const sender = this.sender;
    const delivery = sender
      .send(this.payload(base))
      .then(() => {
        event.delivery = "sent";
      })
      .catch(() => {
        event.delivery = "failed";
      })
      .finally(() => {
        this.deliveries.delete(delivery);
      });
    this.deliveries.add(delivery);
  }
}
