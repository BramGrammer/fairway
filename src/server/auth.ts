// Owner login: a single user from the environment, a stateless signed session
// cookie, slowed-down password guessing and proxy-aware source addresses.
// The app only mounts `auth.routes` and `auth.guard`; nothing else here leaks.
import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

export const SESSION_COOKIE = "fairway_session";

const IDLE_MS = 12 * 3_600_000;
const ABSOLUTE_MS = 7 * 24 * 3_600_000;

// Guess limits. The delay is min(BASE * 2^(n-1), MAX) for the n-th consecutive
// failure from one address; a quiet period forgets the address.
const DELAY_BASE_MS = 250;
const DELAY_MAX_MS = 5_000;
const QUIET_RESET_MS = 15 * 60_000;
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_THRESHOLD = 20;
const GLOBAL_EXTRA_MS = 250;

/** Requests carrying this header (periodic polls) need a session but never renew it. */
export const BACKGROUND_HEADER = "x-fairway-background";

const LOGIN_ERROR = "Wrong username or password";

export interface AuthOptions {
  /** AUTH_USER. Must be set together with `password` or `passwordHash`. */
  user?: string;
  /** AUTH_PASSWORD. Ignored when `passwordHash` is set. */
  password?: string;
  /** AUTH_PASSWORD_HASH, as produced by `hashPassword`. Wins over `password`. */
  passwordHash?: string;
  /** Folder where the signing secret is kept (file `auth-secret`, mode 0600). */
  dataDir: string;
  /** Already parsed (see parseTrustProxy): proxies whose X-Forwarded-* headers are believed. */
  trustProxy?: string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Auth {
  /** False when no credentials are configured: the guard lets everything through. */
  enabled: boolean;
  /** Mount at `/api/auth`: POST /login, POST /logout, GET /status. */
  routes: Hono;
  /** Protects the routes it is applied to; refreshes the cookie on activity. */
  guard: MiddlewareHandler;
}

// ---------------------------------------------------------------- passwords

const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 64, saltLength: 16 };

function scryptAsync(password: string, salt: Buffer, keyLength: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Makes a value for AUTH_PASSWORD_HASH: `scrypt$N$r$p$saltB64$hashB64`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltLength);
  const key = await scryptAsync(password, salt, SCRYPT.keyLength, SCRYPT.N, SCRYPT.r, SCRYPT.p);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parseHash(value: string): ParsedHash {
  const bad = (why: string) =>
    new Error(`AUTH_PASSWORD_HASH is not a valid hash (${why}). Expected scrypt$N$r$p$salt$hash, made with hashPassword().`);
  const parts = value.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") throw bad("wrong format");
  const [N, r, p] = [parts[1], parts[2], parts[3]].map((s) => (/^\d+$/.test(s!) ? Number(s) : NaN)) as [number, number, number];
  if (!(N >= 2 && N <= 1 << 20 && (N & (N - 1)) === 0)) throw bad("bad N");
  if (!(r >= 1 && r <= 32)) throw bad("bad r");
  if (!(p >= 1 && p <= 16)) throw bad("bad p");
  const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
  if (!b64.test(parts[4]!) || !b64.test(parts[5]!)) throw bad("salt or hash is not base64");
  const salt = Buffer.from(parts[4]!, "base64");
  const key = Buffer.from(parts[5]!, "base64");
  if (salt.length < 8 || key.length < 16) throw bad("salt or hash too short");
  return { N, r, p, salt, key };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function equalDigests(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

// ----------------------------------------------------------------- addresses

interface Ip {
  v: 4 | 6;
  n: bigint;
}

function parseIp(raw: string): Ip | null {
  let text = raw.trim().replace(/%.*$/, "");
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const kind = isIP(text);
  if (kind === 4) {
    return { v: 4, n: text.split(".").reduce((acc, part) => (acc << 8n) | BigInt(part), 0n) };
  }
  if (kind === 6) {
    let tail = 0n;
    let words: string[];
    let head = text;
    const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(head);
    let tailWords = 0;
    if (dotted) {
      const v4 = parseIp(dotted[1]!)!.n;
      head = head.slice(0, -dotted[1]!.length) + "0:0";
      tail = v4;
      tailWords = 2;
    }
    const [left, right] = head.split("::");
    const l = left ? left.split(":") : [];
    const rr = right === undefined ? [] : right ? right.split(":") : [];
    const fill = 8 - l.length - rr.length;
    words = right === undefined ? l : [...l, ...Array<string>(fill).fill("0"), ...rr];
    let n = words.reduce((acc, w) => (acc << 16n) | BigInt(parseInt(w || "0", 16)), 0n);
    if (tailWords) n = (n & ~0xffffffffn) | tail;
    if (n >> 32n === 0xffffn) return { v: 4, n: n & 0xffffffffn }; // ::ffff:a.b.c.d
    return { v: 6, n };
  }
  return null;
}

function formatIpv4(n: bigint): string {
  return [24n, 16n, 8n, 0n].map((s) => String((n >> s) & 255n)).join(".");
}

/** Canonical key for an address: IPv4-mapped IPv6 collapses to dotted IPv4. */
function addressKey(raw: string | undefined): string {
  if (!raw) return "unknown";
  const ip = parseIp(raw);
  if (!ip) return raw.toLowerCase();
  return ip.v === 4 ? formatIpv4(ip.n) : `v6:${ip.n.toString(16)}`;
}

interface Range {
  ip: Ip;
  bits: number;
}

function parseRange(entry: string): Range | null {
  const [addr, prefix, ...rest] = entry.split("/");
  if (rest.length || !addr) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.v === 4 ? 32 : 128;
  if (prefix === undefined) return { ip, bits: max };
  if (!/^\d+$/.test(prefix) || Number(prefix) > max) return null;
  return { ip, bits: Number(prefix) };
}

function inRange(ip: Ip, range: Range): boolean {
  if (ip.v !== range.ip.v) return false;
  const total = BigInt(ip.v === 4 ? 32 : 128);
  const shift = total - BigInt(range.bits);
  return ip.n >> shift === range.ip.n >> shift;
}

/** Parses TRUST_PROXY: comma separated IPs / CIDRs. Throws on an invalid entry. */
export function parseTrustProxy(value: string | undefined): string[] {
  const entries = (value ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  for (const entry of entries) {
    if (!parseRange(entry)) {
      throw new Error(`TRUST_PROXY has an invalid entry "${entry}": use IP addresses or CIDR ranges such as 172.18.0.0/16, separated by commas.`);
    }
  }
  return entries;
}

/** Socket address of the connecting peer: node server env, or `{ remoteAddress }` in tests. */
function socketAddress(c: Context): string | undefined {
  const env = c.env as
    | { incoming?: { socket?: { remoteAddress?: string } }; remoteAddress?: string }
    | undefined;
  return env?.incoming?.socket?.remoteAddress ?? env?.remoteAddress;
}

// ------------------------------------------------------------------- session

interface Session {
  u: string; // username
  i: number; // issued at
  a: number; // last active
}

function sign(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

function encode(key: Buffer, session: Session): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${sign(key, payload)}`;
}

function decode(key: Buffer, value: string | undefined, now: number): Session | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts as [string, string];
  const expected = Buffer.from(sign(key, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let session: Session;
  try {
    session = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (typeof session?.u !== "string" || !Number.isFinite(session.i) || !Number.isFinite(session.a)) return null;
  if (now - session.a > IDLE_MS || now - session.i > ABSOLUTE_MS || session.a - now > 60_000) return null;
  return session;
}

async function loadSecret(dataDir: string): Promise<Buffer> {
  const file = join(dataDir, "auth-secret");
  await mkdir(dataDir, { recursive: true });
  try {
    await writeFile(file, randomBytes(32).toString("base64"), { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const secret = Buffer.from((await readFile(file, "utf8")).trim(), "base64");
  if (secret.length < 32) throw new Error(`${file} is corrupt: delete it to generate a new signing secret.`);
  return secret;
}

// -------------------------------------------------------------------- module

export async function createAuth(options: AuthOptions): Promise<Auth> {
  const { user, password, passwordHash } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const credential = passwordHash || password;
  if (!user && !credential) {
    return {
      enabled: false,
      routes: new Hono()
        .get("/status", (c) => c.json({ mode: "none" }))
        .post("/login", (c) => c.json({ ok: false, error: "Login is not enabled" }, 400))
        .post("/logout", (c) => c.json({ ok: true })),
      guard: async (_c, next) => next(),
    };
  }
  if (!user || !credential) {
    throw new Error("Set both AUTH_USER and AUTH_PASSWORD (or AUTH_PASSWORD_HASH), or neither to run without login.");
  }

  const owner: string = user;
  const hash = passwordHash ? parseHash(passwordHash) : null;
  const trusted = (options.trustProxy ?? []).map((entry) => {
    const range = parseRange(entry);
    if (!range) throw new Error(`TRUST_PROXY has an invalid entry "${entry}": pass the list through parseTrustProxy first.`);
    return range;
  });
  const isTrusted = (raw: string): boolean => {
    const ip = parseIp(raw);
    return !!ip && trusted.some((range) => inRange(ip, range));
  };

  // The credential is part of the key, so changing it invalidates every cookie.
  const secret = await loadSecret(options.dataDir);
  const key = createHmac("sha256", secret)
    .update(`${hash ? "hash" : "password"}\0${owner}\0${credential}`)
    .digest();

  async function passwordMatches(candidate: string): Promise<boolean> {
    if (hash) {
      const derived = await scryptAsync(candidate, hash.salt, hash.key.length, hash.N, hash.r, hash.p);
      return timingSafeEqual(derived, hash.key);
    }
    return equalDigests(candidate, password!);
  }

  // Where a request really came from, and whether it arrived over HTTPS.
  function origin(c: Context): { address: string; https: boolean } {
    const socket = socketAddress(c);
    const direct = new URL(c.req.url).protocol === "https:";
    if (!socket || !isTrusted(socket)) return { address: addressKey(socket), https: direct };
    const chain = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    const client = [...chain].reverse().find((entry) => !isTrusted(entry)) ?? chain[0] ?? socket;
    const protos = (c.req.header("x-forwarded-proto") ?? "").split(",").map((p) => p.trim().toLowerCase());
    return { address: addressKey(client), https: direct || protos[protos.length - 1] === "https" };
  }

  // Failure bookkeeping, in memory only.
  const failures = new Map<string, { count: number; last: number }>();
  let recent: number[] = [];
  const queues = new Map<string, Promise<void>>();
  const MAX_TRACKED = 10_000;

  function prune(t: number): void {
    for (const [address, f] of failures) if (t - f.last >= QUIET_RESET_MS) failures.delete(address);
    // Hard cap: forget the oldest entries (Map keeps insertion order).
    for (const address of failures.keys()) {
      if (failures.size <= MAX_TRACKED) break;
      failures.delete(address);
    }
    recent = recent.filter((at) => t - at < GLOBAL_WINDOW_MS).slice(-MAX_TRACKED);
  }

  function recentFailures(t: number): number {
    prune(t);
    return recent.length;
  }

  function issue(c: Context, session: Session, https: boolean): void {
    const t = now();
    const remaining = session.i + ABSOLUTE_MS - t;
    setCookie(c, SESSION_COOKIE, encode(key, session), {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      secure: https,
      maxAge: Math.max(0, Math.floor(Math.min(IDLE_MS, remaining) / 1000)),
    });
  }

  const current = (c: Context): Session | null => decode(key, getCookie(c, SESSION_COOKIE), now());

  // Background polls must not count as activity, or an open forgotten tab never idles out.
  const refresh = (c: Context, session: Session): void => {
    if (c.req.header(BACKGROUND_HEADER) === "1") return;
    issue(c, { ...session, a: now() }, origin(c).https);
  };

  const routes = new Hono();

  routes.post("/login", async (c) => {
    const { address, https } = origin(c);
    // One attempt at a time per address, so the delay after attempt n is served before attempt n+1 is checked.
    const turn = (queues.get(address) ?? Promise.resolve()).catch(() => {});
    const done = turn.then(() => attempt(c, address, https));
    const tail = done.then(() => {}, () => {});
    queues.set(address, tail);
    void tail.then(() => {
      if (queues.get(address) === tail) queues.delete(address);
    });
    return done;
  });

  async function attempt(c: Context, address: string, https: boolean): Promise<Response> {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      /* treated as a failed sign-in below */
    }
    const given = body as { username?: unknown; password?: unknown } | null;
    const username = typeof given?.username === "string" ? given.username : "";
    const candidate = typeof given?.password === "string" ? given.password : "";
    // Evaluate both so a wrong user costs the same as a wrong password.
    const userOk = equalDigests(username, owner);
    const passwordOk = await passwordMatches(candidate);
    const ok = userOk && passwordOk && typeof given?.username === "string";

    const t = now();
    let delay = 0;
    if (ok) {
      failures.delete(address);
    } else {
      const previous = failures.get(address);
      const count = previous && t - previous.last < QUIET_RESET_MS ? previous.count + 1 : 1;
      failures.delete(address); // keeps the Map ordered oldest-first for the size cap
      failures.set(address, { count, last: t });
      recent.push(t);
      delay = Math.min(DELAY_BASE_MS * 2 ** (count - 1), DELAY_MAX_MS);
    }
    if (recentFailures(t) >= GLOBAL_THRESHOLD) delay += GLOBAL_EXTRA_MS;
    if (delay > 0) await sleep(delay);

    if (!ok) return c.json({ ok: false, error: LOGIN_ERROR }, 401);
    issue(c, { u: owner, i: t, a: t }, https);
    return c.json({ ok: true, user: owner });
  }

  routes.post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  routes.get("/status", (c) => {
    const session = current(c);
    if (session) refresh(c, session);
    return c.json({ mode: "login", signedIn: !!session, user: session?.u ?? null });
  });

  const guard: MiddlewareHandler = async (c, next) => {
    const session = current(c);
    if (!session) return c.json({ ok: false, error: "Sign in required" }, 401);
    refresh(c, session);
    await next();
  };

  return { enabled: true, routes, guard };
}
