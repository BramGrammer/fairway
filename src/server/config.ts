export interface Config {
  port: number;
  host: string;
  adminSocket: string;
  /** The caddy binary used for `caddy fmt`. */
  caddyBin: string;
  caddyfilePath: string;
  dataDir: string;
  logDir: string;
  logFile: string;
  maxRevisions: number;
  /** Caddy's TLS address (`host[:port]`) for probing Certificates; null disables probing. */
  tlsProbeAddr: string | null;
  /** Opt-in synthetic check of each host; also needs `tlsProbeAddr`. */
  hostCheck: boolean;
  /** ntfy topic addresses (comma separated); empty means alerting is off. Never sent back through the API. */
  ntfyUrl: string | null;
  /** Access token for the ntfy topic, if it needs a login. */
  ntfyToken: string | null;
  /** Fairway's own address, used for the link in an Alert. */
  publicUrl: string | null;
  /** Address of the OpenAI-compatible endpoint the Assistant and Reviews use; null means OpenRouter's. */
  aiBaseUrl: string | null;
  /** The key for that endpoint. Never sent back through the API. */
  aiApiKey: string | null;
  /** Default model for the Assistant; null means none chosen. */
  aiAssistantModel: string | null;
  /** Default model for Reviews; null means none chosen. */
  aiReviewModel: string | null;
  /** Default for how often a Review runs: off, 6h, 12h, 24h or weekly; null means 24h. */
  aiReviewInterval: string | null;
  webRoot: string;
  /** The Owner's login. Neither set means Fairway runs open; a hash wins over a password. */
  authUser: string | null;
  authPassword: string | null;
  authPasswordHash: string | null;
  /** Comma separated proxy addresses or ranges whose forwarded headers are believed. */
  trustProxy: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? "0.0.0.0",
    adminSocket: env.ADMIN_SOCKET ?? "/run/caddy-admin/admin.sock",
    caddyBin: env.CADDY_BIN ?? "caddy",
    caddyfilePath: env.CADDYFILE_PATH ?? "/caddyfile/Caddyfile",
    dataDir: env.DATA_DIR ?? "/data",
    logDir: env.LOG_DIR ?? "/var/log/caddy",
    logFile: env.LOG_FILE ?? "access.log",
    maxRevisions: Number(env.MAX_REVISIONS ?? 50),
    tlsProbeAddr: env.TLS_PROBE_ADDR?.trim() || null,
    hostCheck: /^(1|true|on)$/i.test(env.HOST_CHECK?.trim() ?? ""),
    ntfyUrl: env.NTFY_URL?.trim() || null,
    ntfyToken: env.NTFY_TOKEN?.trim() || null,
    publicUrl: env.PUBLIC_URL?.trim() || null,
    aiBaseUrl: env.AI_BASE_URL?.trim() || null,
    aiApiKey: env.AI_API_KEY?.trim() || null,
    aiAssistantModel: env.AI_ASSISTANT_MODEL?.trim() || null,
    aiReviewModel: env.AI_REVIEW_MODEL?.trim() || null,
    aiReviewInterval: env.AI_REVIEW_INTERVAL?.trim() || null,
    webRoot: env.WEB_ROOT ?? "dist/web",
    authUser: env.AUTH_USER || null,
    authPassword: env.AUTH_PASSWORD || null,
    authPasswordHash: env.AUTH_PASSWORD_HASH || null,
    trustProxy: env.TRUST_PROXY ?? "",
  };
}
