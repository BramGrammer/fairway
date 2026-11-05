import { request } from "node:http";

export interface Warning {
  file?: string;
  line?: number;
  message: string;
}

export type AdaptResult = { ok: true; warnings: Warning[] } | { ok: false; error: string };
export type LoadResult = { ok: true } | { ok: false; error: string };
export type ServersResult = { ok: true; servers: Record<string, unknown> } | { ok: false; error: string };

interface Reply {
  status: number;
  body: string;
}

/** Client for Caddy's admin API over a Unix socket. */
export class CaddyAdmin {
  constructor(private readonly socketPath: string) {}

  private send(method: string, path: string, body?: string): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers: {
            Host: "localhost",
            ...(body !== undefined && {
              "Content-Type": "text/caddyfile",
              "Content-Length": Buffer.byteLength(body),
            }),
          },
          timeout: 15_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
          );
        },
      );
      req.on("timeout", () => req.destroy(new Error("Caddy admin API timed out")));
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.send("GET", "/config/")).status === 200;
    } catch {
      return false;
    }
  }

  /** Checks a Caddyfile against the running Caddy's own modules without applying it. */
  async adapt(caddyfile: string): Promise<AdaptResult> {
    try {
      const reply = await this.send("POST", "/adapt", caddyfile);
      if (reply.status === 200) {
        const parsed = JSON.parse(reply.body) as { warnings?: Warning[] };
        return { ok: true, warnings: parsed.warnings ?? [] };
      }
      return { ok: false, error: errorMessage(reply) };
    } catch (error) {
      return { ok: false, error: `Cannot reach Caddy: ${(error as Error).message}` };
    }
  }

  /** Caddy's Prometheus metrics, as text. */
  async metricsText(): Promise<string> {
    const reply = await this.send("GET", "/metrics");
    if (reply.status !== 200) throw new Error(errorMessage(reply));
    return reply.body;
  }

  /** The running config's `metrics` option, or null while metrics are switched off. */
  async metricsConfig(): Promise<{ perHost: boolean } | null> {
    const reply = await this.send("GET", "/config/apps/http/metrics");
    if (reply.status !== 200) return null;
    const parsed = JSON.parse(reply.body) as { per_host?: boolean } | null;
    return parsed ? { perHost: parsed.per_host === true } : null;
  }

  /** The HTTP servers of the config Caddy is running now. */
  async liveServers(): Promise<ServersResult> {
    try {
      const reply = await this.send("GET", "/config/apps/http/servers");
      if (reply.status !== 200) return { ok: false, error: errorMessage(reply) };
      return { ok: true, servers: (JSON.parse(reply.body) as Record<string, unknown> | null) ?? {} };
    } catch (error) {
      return { ok: false, error: `Cannot reach Caddy: ${(error as Error).message}` };
    }
  }

  /** The HTTP servers a Caddyfile would produce, without applying it. */
  async adaptedServers(caddyfile: string): Promise<ServersResult> {
    try {
      const reply = await this.send("POST", "/adapt", caddyfile);
      if (reply.status !== 200) return { ok: false, error: errorMessage(reply) };
      const parsed = JSON.parse(reply.body) as { result?: { apps?: { http?: { servers?: Record<string, unknown> } } } };
      return { ok: true, servers: parsed.result?.apps?.http?.servers ?? {} };
    } catch (error) {
      return { ok: false, error: `Cannot reach Caddy: ${(error as Error).message}` };
    }
  }

  /** Reloads Caddy in place. Caddy keeps the old config running if this fails. */
  async load(caddyfile: string): Promise<LoadResult> {
    try {
      const reply = await this.send("POST", "/load", caddyfile);
      return reply.status === 200 ? { ok: true } : { ok: false, error: errorMessage(reply) };
    } catch (error) {
      return { ok: false, error: `Cannot reach Caddy: ${(error as Error).message}` };
    }
  }
}

function errorMessage(reply: Reply): string {
  try {
    const parsed = JSON.parse(reply.body) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    // not JSON, fall through
  }
  return reply.body.trim() || `Caddy replied with HTTP ${reply.status}`;
}
