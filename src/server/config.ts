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
    webRoot: env.WEB_ROOT ?? "dist/web",
    authUser: env.AUTH_USER || null,
    authPassword: env.AUTH_PASSWORD || null,
    authPasswordHash: env.AUTH_PASSWORD_HASH || null,
    trustProxy: env.TRUST_PROXY ?? "",
  };
}
