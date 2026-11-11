/**
 * Delivers an Alert as a push message to the Owner's ntfy topic(s). The topic URL and the token are secrets:
 * they never appear in an error or a response.
 */

export interface AlertPayload {
  /** What kind of occurrence this is: `state`, `flapping`, `deploy_failed`, `external_edit` or `test`. */
  event: string;
  subject: string | null;
  state: string | null;
  previous: string | null;
  /** ISO time the State began or the occurrence happened. */
  since: string;
  message: string;
  link?: string;
  test?: boolean;
}

export interface AlertSender {
  /** Resolves once delivered everywhere; rejects after the last attempt fails anywhere. */
  send(payload: AlertPayload, options?: { retry?: boolean }): Promise<void>;
}

/** Pause before the second, third and fourth attempt. */
export const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
const TIMEOUT_MS = 10_000;

/** A topic address, or one with its own access token. */
export type NtfyTarget = string | { url: string; token?: string | null };

export interface NtfyOptions {
  /** Access token for topics given as plain addresses, when they need a login. */
  token?: string | null;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  delays?: number[];
  timeoutMs?: number;
}

interface Look {
  title: string;
  priority: string;
  tags: string;
}

/** Title, priority and emoji for a message. Header values stay plain ASCII. */
export function ntfyLook(payload: AlertPayload): Look {
  if (payload.test) return { title: "Fairway: test", priority: "default", tags: "bell" };
  switch (payload.event) {
    case "deploy_failed":
      return { title: "Fairway: deploy failed", priority: "high", tags: "x" };
    case "external_edit":
      return { title: "Fairway: Caddyfile edited", priority: "default", tags: "pencil2" };
    case "flapping":
      return { title: "Fairway: unstable", priority: "default", tags: "repeat" };
    default:
      if (payload.state === "down") return { title: "Fairway: problem", priority: "high", tags: "rotating_light" };
      if (payload.state === "warning") return { title: "Fairway: warning", priority: "default", tags: "warning" };
      return { title: "Fairway: recovered", priority: "default", tags: "white_check_mark" };
  }
}

export class NtfySender implements AlertSender {
  private readonly targets: Array<{ url: string; token: string | null }>;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly delays: number[];
  private readonly timeoutMs: number;

  /** Targets are full topic addresses, for example `https://ntfy.example.test/fairway`. */
  constructor(targets: NtfyTarget[], options: NtfyOptions = {}) {
    this.targets = targets.map((target) =>
      typeof target === "string" ? { url: target, token: options.token || null } : { url: target.url, token: target.token || null },
    );
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
    this.delays = options.delays ?? RETRY_DELAYS_MS;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  }

  async send(payload: AlertPayload, options: { retry?: boolean } = {}): Promise<void> {
    const results = await Promise.allSettled(this.targets.map((target) => this.sendTo(target, payload, options.retry === false ? [] : this.delays)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }

  private async sendTo({ url, token }: { url: string; token: string | null }, payload: AlertPayload, delays: number[]): Promise<void> {
    const look = ntfyLook(payload);
    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
      Title: look.title,
      Priority: look.priority,
      Tags: look.tags,
      ...(payload.link && { Click: payload.link }),
      ...(token && { Authorization: `Bearer ${token}` }),
    };
    let failure = "";
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await this.sleep(delays[attempt - 1]);
      try {
        const response = await this.fetchFn(url, {
          method: "POST",
          headers,
          body: payload.message,
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: "error",
        });
        if (response.ok) return;
        failure = `ntfy answered ${response.status}.`;
      } catch (error) {
        // The URL can appear in a fetch error's cause, so only a generic message is kept.
        failure = (error as Error).name === "TimeoutError" ? "ntfy timed out." : "ntfy could not be reached.";
      }
    }
    throw new Error(failure);
  }
}

/** `NTFY_URL` may hold several topic addresses, separated by commas. */
export function parseNtfyUrls(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}
