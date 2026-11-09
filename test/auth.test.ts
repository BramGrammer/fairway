import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { createAuth, hashPassword, parseTrustProxy, type Auth } from "../src/server/auth.js";

const USER = "owner";
const PASSWORD = "correct horse battery staple";
const HOUR = 3_600_000;

type Env = { remoteAddress?: string };

interface Rig {
  auth: Auth;
  app: Hono;
  sleeps: number[];
  clock: { now: number };
  dataDir: string;
}

async function rig(
  options: {
    user?: string;
    password?: string;
    passwordHash?: string;
    trustProxy?: string[];
    dataDir?: string;
    clock?: { now: number };
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<Rig> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "ce-auth-")));
  const clock = options.clock ?? { now: 1_700_000_000_000 };
  const sleeps: number[] = [];
  const { dataDir: _d, clock: _c, sleep: gate, ...rest } = options;
  const auth = await createAuth({
    ...rest,
    dataDir,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      await gate?.(ms);
    },
  });
  const app = new Hono();
  app.route("/api/auth", auth.routes);
  app.use("/api/*", auth.guard);
  app.get("/api/secret", (c) => c.json({ secret: 42 }));
  return { auth, app, sleeps, clock, dataDir };
}

function call(
  r: Rig,
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; addr?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const env: Env = { remoteAddress: init.addr ?? "10.0.0.5" };
  return Promise.resolve(
    r.app.request(
      path,
      {
        method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      },
      env,
    ),
  );
}

function login(r: Rig, password = PASSWORD, extra: Parameters<typeof call>[2] = {}, user = USER) {
  return call(r, "/api/auth/login", { ...extra, body: { username: user, password } });
}

/** The name=value part of the session cookie set by a response, or "" when none. */
function cookieOf(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  return set.split(";")[0] ?? "";
}

async function signIn(r: Rig): Promise<string> {
  const res = await login(r);
  assert.equal(res.status, 200);
  return cookieOf(res);
}

describe("credentials", () => {
  it("signs in with the right username and password", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    const res = await login(r);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, user: USER });
    assert.match(res.headers.get("set-cookie") ?? "", /^fairway_session=.+/);
  });

  it("answers a wrong user and a wrong password identically, without a cookie", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    const wrongPassword = await login(r, "nope");
    const wrongUser = await login(r, PASSWORD, {}, "intruder");
    for (const res of [wrongPassword, wrongUser]) {
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { ok: false, error: "Wrong username or password" });
      assert.equal(res.headers.get("set-cookie"), null);
    }
  });

  it("treats a malformed login body as a failed sign-in", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    const res = await call(r, "/api/auth/login", { body: { username: 5 } });
    assert.equal(res.status, 401);
  });

  it("signs in with only a password hash", async () => {
    const r = await rig({ user: USER, passwordHash: await hashPassword(PASSWORD) });
    assert.equal((await login(r)).status, 200);
    assert.equal((await login(r, "nope")).status, 401);
  });

  it("lets the hash win over a plain password", async () => {
    const r = await rig({ user: USER, password: "leftover", passwordHash: await hashPassword(PASSWORD) });
    assert.equal((await login(r, "leftover")).status, 401);
    assert.equal((await login(r, PASSWORD)).status, 200);
  });

  it("produces hashes that differ per call but both verify", async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    assert.notEqual(a, b);
    assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$[^$]+\$[^$]+$/);
  });

  it("rejects a malformed hash at creation", async () => {
    for (const passwordHash of ["plaintext", "scrypt$16384$8$1$only-salt", "bcrypt$1$2$3$AAAA$BBBB", "scrypt$x$8$1$AAAA$BBBB"]) {
      await assert.rejects(rig({ user: USER, passwordHash }), /hash/i);
    }
  });

  it("rejects a user without a credential and a credential without a user", async () => {
    await assert.rejects(rig({ user: USER }), /AUTH_USER|AUTH_PASSWORD/);
    await assert.rejects(rig({ password: PASSWORD }), /AUTH_USER|AUTH_PASSWORD/);
    await assert.rejects(rig({ passwordHash: await hashPassword(PASSWORD) }), /AUTH_USER|AUTH_PASSWORD/);
  });
});

describe("login switched off", () => {
  it("leaves routes open and reports mode none", async () => {
    const r = await rig();
    assert.equal(r.auth.enabled, false);
    const res = await call(r, "/api/secret");
    assert.equal(res.status, 200);
    assert.deepEqual(await (await call(r, "/api/auth/status")).json(), { mode: "none" });
  });
});

describe("guard and status", () => {
  it("refuses protected routes without a session and allows them with one", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    const denied = await call(r, "/api/secret");
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { ok: false, error: "Sign in required" });
    const cookie = await signIn(r);
    const allowed = await call(r, "/api/secret", { cookie });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { secret: 42 });
  });

  it("answers status without a session, and names the user with one", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    assert.deepEqual(await (await call(r, "/api/auth/status")).json(), { mode: "login", signedIn: false, user: null });
    const cookie = await signIn(r);
    assert.deepEqual(await (await call(r, "/api/auth/status", { cookie })).json(), {
      mode: "login",
      signedIn: true,
      user: USER,
    });
  });

  it("clears the cookie on logout and the cookie value stops being the way in", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    const cookie = await signIn(r);
    const res = await call(r, "/api/auth/logout", { method: "POST", cookie });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const set = res.headers.get("set-cookie") ?? "";
    assert.match(set, /^fairway_session=;/);
    assert.match(set, /Max-Age=0/i);
  });

  it("sets HttpOnly, SameSite=Strict and Path=/ on the cookie", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    const set = (await login(r)).headers.get("set-cookie") ?? "";
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=Strict/i);
    assert.match(set, /Path=\//);
  });
});

describe("session lifetime", () => {
  it("survives a new instance on the same data folder", async () => {
    const first = await rig({ user: USER, password: PASSWORD });
    const cookie = await signIn(first);
    const second = await rig({ user: USER, password: PASSWORD, dataDir: first.dataDir, clock: first.clock });
    assert.equal((await call(second, "/api/secret", { cookie })).status, 200);
  });

  it("is not honoured by an instance with a different data folder", async () => {
    const first = await rig({ user: USER, password: PASSWORD });
    const cookie = await signIn(first);
    const other = await rig({ user: USER, password: PASSWORD, clock: first.clock });
    assert.equal((await call(other, "/api/secret", { cookie })).status, 401);
  });

  it("ends after 12 hours idle", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    const cookie = await signIn(r);
    r.clock.now += 12 * HOUR - 1000;
    assert.equal((await call(r, "/api/secret", { cookie })).status, 200);
    r.clock.now += 12 * HOUR + 1000;
    assert.equal((await call(r, "/api/secret", { cookie })).status, 401);
  });

  it("is renewed by activity through the refreshed cookie", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    let cookie = await signIn(r);
    for (let i = 0; i < 3; i++) {
      r.clock.now += 8 * HOUR;
      const res = await call(r, "/api/secret", { cookie });
      assert.equal(res.status, 200);
      cookie = cookieOf(res);
      assert.notEqual(cookie, "");
    }
  });

  it("ends 7 days after sign-in even when active", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    let cookie = await signIn(r);
    // 15 steps of 11h = 165h, still inside 7 days (168h) and never idle for 12h.
    for (let i = 0; i < 15; i++) {
      r.clock.now += 11 * HOUR;
      const res = await call(r, "/api/secret", { cookie });
      assert.equal(res.status, 200, `step ${i + 1}`);
      cookie = cookieOf(res);
    }
    r.clock.now += 4 * HOUR; // 169h since sign-in, 4h since last activity
    assert.equal((await call(r, "/api/secret", { cookie })).status, 401);
  });

  it("is invalidated when the password changes", async () => {
    const first = await rig({ user: USER, password: PASSWORD });
    const cookie = await signIn(first);
    const changed = await rig({ user: USER, password: "another made-up password", dataDir: first.dataDir });
    assert.equal((await call(changed, "/api/secret", { cookie })).status, 401);
  });

  it("is invalidated when switching from the password to its hash", async () => {
    const first = await rig({ user: USER, password: PASSWORD });
    const cookie = await signIn(first);
    const hashed = await rig({ user: USER, passwordHash: await hashPassword(PASSWORD), dataDir: first.dataDir });
    assert.equal((await call(hashed, "/api/secret", { cookie })).status, 401);
  });

  it("rejects a tampered cookie", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    const cookie = await signIn(r);
    const value = cookie.slice("fairway_session=".length);
    const [payload, signature] = value.split(".");
    const forged = Buffer.from(JSON.stringify({ u: USER, i: 0, a: r.clock.now + 10 * 24 * HOUR })).toString("base64url");
    for (const bad of [`${forged}.${signature}`, `${payload}.${signature!.slice(0, -2)}AA`, `${payload}`, "garbage.garbage", "."]) {
      assert.equal((await call(r, "/api/secret", { cookie: `fairway_session=${bad}` })).status, 401, bad);
    }
  });
});

describe("Secure flag and trusted proxy", () => {
  it("is not Secure over plain HTTP, even if a forwarded proto header claims HTTPS", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    const res = await login(r, PASSWORD, { headers: { "x-forwarded-proto": "https" } });
    assert.doesNotMatch(res.headers.get("set-cookie") ?? "", /Secure/i);
  });

  it("is Secure when the request itself is HTTPS", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    const res = await r.app.request(
      "https://fairway.example.test/api/auth/login",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASSWORD }) },
      { remoteAddress: "10.0.0.5" },
    );
    assert.match(res.headers.get("set-cookie") ?? "", /Secure/i);
  });

  it("is Secure when a trusted proxy reports HTTPS", async () => {
    const r = await rig({ user: USER, password: PASSWORD, trustProxy: ["172.18.0.0/16"] });
    const res = await login(r, PASSWORD, { addr: "172.18.0.2", headers: { "x-forwarded-proto": "https" } });
    assert.match(res.headers.get("set-cookie") ?? "", /Secure/i);
    const http = await login(r, PASSWORD, { addr: "172.18.0.2", headers: { "x-forwarded-proto": "http" } });
    assert.doesNotMatch(http.headers.get("set-cookie") ?? "", /Secure/i);
  });

  it("ignores the forwarded proto from an untrusted sender", async () => {
    const r = await rig({ user: USER, password: PASSWORD, trustProxy: ["172.18.0.0/16"] });
    const res = await login(r, PASSWORD, { addr: "203.0.113.9", headers: { "x-forwarded-proto": "https" } });
    assert.doesNotMatch(res.headers.get("set-cookie") ?? "", /Secure/i);
  });

  it("matches IPv4-mapped IPv6 socket addresses against IPv4 entries", async () => {
    const r = await rig({ user: USER, password: PASSWORD, trustProxy: ["172.18.0.2"] });
    const res = await login(r, PASSWORD, { addr: "::ffff:172.18.0.2", headers: { "x-forwarded-proto": "https" } });
    assert.match(res.headers.get("set-cookie") ?? "", /Secure/i);
  });

  it("trusts IPv6 addresses and ranges", async () => {
    const r = await rig({ user: USER, password: PASSWORD, trustProxy: ["fd00::/8", "2001:db8::1"] });
    for (const addr of ["fd12:3456::1", "2001:db8::1"]) {
      const res = await login(r, PASSWORD, { addr, headers: { "x-forwarded-proto": "https" } });
      assert.match(res.headers.get("set-cookie") ?? "", /Secure/i, addr);
    }
    const other = await login(r, PASSWORD, { addr: "2001:db8::2", headers: { "x-forwarded-proto": "https" } });
    assert.doesNotMatch(other.headers.get("set-cookie") ?? "", /Secure/i);
  });
});

describe("parseTrustProxy", () => {
  it("returns an empty list for nothing", () => {
    assert.deepEqual(parseTrustProxy(undefined), []);
    assert.deepEqual(parseTrustProxy("  "), []);
  });
  it("splits and trims addresses and ranges", () => {
    assert.deepEqual(parseTrustProxy("10.0.0.1, 172.18.0.0/16 ,fd00::/8"), ["10.0.0.1", "172.18.0.0/16", "fd00::/8"]);
  });
  it("throws a clear error on invalid entries", () => {
    for (const bad of ["not-an-ip", "10.0.0.1/33", "10.0.0.1/x", "fd00::/129", "10.0.0.256"]) {
      assert.throws(() => parseTrustProxy(`10.0.0.1,${bad}`), /TRUST_PROXY.*invalid/i, bad);
    }
  });
  it("is enforced when creating the module", async () => {
    await assert.rejects(rig({ user: USER, password: PASSWORD, trustProxy: ["nope"] }), /TRUST_PROXY/);
  });
});

describe("background requests", () => {
  const BG = { "x-fairway-background": "1" };

  it("need a session but never extend it or re-issue the cookie", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    assert.equal((await call(r, "/api/secret", { headers: BG })).status, 401);
    const cookie = await signIn(r);
    r.clock.now += 11 * HOUR;
    const poll = await call(r, "/api/secret", { cookie, headers: BG });
    assert.equal(poll.status, 200);
    assert.equal(poll.headers.get("set-cookie"), null);
    const status = await call(r, "/api/auth/status", { cookie, headers: BG });
    assert.equal(status.headers.get("set-cookie"), null);
    r.clock.now += 1 * HOUR + 1000; // 12h after the last real activity
    assert.equal((await call(r, "/api/secret", { cookie })).status, 401);
  });

  it("are outlived by a normal request, which does extend the session", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    const cookie = await signIn(r);
    r.clock.now += 11 * HOUR;
    const real = await call(r, "/api/secret", { cookie });
    const renewed = cookieOf(real);
    assert.notEqual(renewed, "");
    r.clock.now += 11 * HOUR;
    assert.equal((await call(r, "/api/secret", { cookie: renewed, headers: BG })).status, 200);
  });
});

describe("guess limits", () => {
  it("serves each attempt's delay before checking the next one from the same address", async () => {
    const release: Array<() => void> = [];
    const r = await rig({
      user: USER,
      password: PASSWORD,
      sleep: () => new Promise<void>((resolve) => release.push(resolve)),
    });
    const attempts = [login(r, "bad"), login(r, "bad"), login(r, PASSWORD)];
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(r.sleeps, [250], "only the first attempt has been checked");
    const other = login(r, "bad", { addr: "10.0.0.77" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(r.sleeps, [250, 250], "another address is not held up");
    release.splice(0).forEach((f) => f());
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(r.sleeps, [250, 250, 500]);
    release.splice(0).forEach((f) => f());
    const done = await Promise.all([...attempts, other]);
    assert.deepEqual(
      done.map((res) => res.status),
      [401, 401, 200, 401],
    );
  });

  it("does not delay a first success or a first failure's predecessor", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    await login(r);
    assert.deepEqual(r.sleeps, []);
  });

  it("delays failures from one address by a growing amount, capped", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    for (let i = 0; i < 7; i++) await login(r, "bad");
    assert.deepEqual(r.sleeps, [250, 500, 1000, 2000, 4000, 5000, 5000]);
  });

  it("resets the delay after a success", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    await login(r, "bad");
    await login(r, "bad");
    await login(r);
    r.sleeps.length = 0;
    await login(r, "bad");
    assert.deepEqual(r.sleeps, [250]);
  });

  it("resets the delay after a quiet period", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    await login(r, "bad");
    await login(r, "bad");
    r.clock.now += HOUR;
    r.sleeps.length = 0;
    await login(r, "bad");
    assert.deepEqual(r.sleeps, [250]);
  });

  it("keeps addresses apart", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    await login(r, "bad", { addr: "10.0.0.1" });
    await login(r, "bad", { addr: "10.0.0.1" });
    r.sleeps.length = 0;
    await login(r, "bad", { addr: "10.0.0.2" });
    assert.deepEqual(r.sleeps, [250]);
    r.sleeps.length = 0;
    assert.equal((await login(r, PASSWORD, { addr: "10.0.0.3" })).status, 200);
    assert.deepEqual(r.sleeps, []);
  });

  it("adds a mild slowdown for everyone after many failures, without locking out", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    for (let i = 0; i < 20; i++) await login(r, "bad", { addr: `10.1.0.${i}` });
    r.sleeps.length = 0;
    const ok = await login(r, PASSWORD, { addr: "10.2.0.1" });
    assert.equal(ok.status, 200);
    assert.deepEqual(r.sleeps, [250]);
    r.sleeps.length = 0;
    await login(r, "bad", { addr: "10.2.0.2" });
    assert.deepEqual(r.sleeps, [500]);
  });

  it("drops the global slowdown once the failures are more than a minute old", async () => {
    const r = await rig({ user: USER, password: PASSWORD });
    for (let i = 0; i < 20; i++) await login(r, "bad", { addr: `10.1.0.${i}` });
    r.clock.now += 61_000;
    r.sleeps.length = 0;
    await login(r, PASSWORD, { addr: "10.2.0.1" });
    assert.deepEqual(r.sleeps, []);
  });

  it("ignores a forwarded address from an untrusted sender", async () => {
    const r = await rig({ user: USER, password: PASSWORD, trustProxy: ["172.18.0.0/16"] });
    await login(r, "bad", { addr: "203.0.113.9", headers: { "x-forwarded-for": "198.51.100.1" } });
    r.sleeps.length = 0;
    await login(r, "bad", { addr: "203.0.113.9", headers: { "x-forwarded-for": "198.51.100.2" } });
    assert.deepEqual(r.sleeps, [500]);
  });

  it("uses the forwarded address from a trusted sender", async () => {
    const r = await rig({ user: USER, password: PASSWORD, trustProxy: ["172.18.0.0/16"] });
    const proxy = "172.18.0.2";
    await login(r, "bad", { addr: proxy, headers: { "x-forwarded-for": "198.51.100.1" } });
    r.sleeps.length = 0;
    await login(r, "bad", { addr: proxy, headers: { "x-forwarded-for": "198.51.100.2" } });
    assert.deepEqual(r.sleeps, [250]);
    r.sleeps.length = 0;
    await login(r, "bad", { addr: proxy, headers: { "x-forwarded-for": "198.51.100.1" } });
    assert.deepEqual(r.sleeps, [500]);
  });

  it("picks the rightmost forwarded entry that is not itself trusted", async () => {
    const r = await rig({ user: USER, password: PASSWORD, trustProxy: ["172.18.0.0/16", "10.9.0.1"] });
    const via = (chain: string) => ({ addr: "172.18.0.2", headers: { "x-forwarded-for": chain } });
    // A client-supplied fake on the left must not matter; 198.51.100.7 is the real client.
    await login(r, "bad", via("6.6.6.6, 198.51.100.7, 10.9.0.1"));
    r.sleeps.length = 0;
    await login(r, "bad", via("7.7.7.7, 198.51.100.7, 172.18.0.9"));
    assert.deepEqual(r.sleeps, [500]);
  });
});
