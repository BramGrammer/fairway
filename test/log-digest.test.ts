import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { buildLogDigest, type LogDigest } from "../src/server/log-digest.js";

const HOUR = 3_600_000;
const T0 = Date.UTC(2030, 0, 1, 0, 0, 0); // a made-up day

interface Spec {
  host?: string;
  at: number; // ms
  status?: number;
  method?: string;
  uri?: string;
  client?: string;
  ua?: string;
}

function entry(s: Spec): string {
  return JSON.stringify({
    level: "info",
    ts: s.at / 1000,
    logger: "http.log.access",
    msg: "handled request",
    request: {
      remote_ip: s.client ?? "192.0.2.1",
      remote_addr: `${s.client ?? "192.0.2.1"}:5000`,
      method: s.method ?? "GET",
      host: s.host ?? "app.example.test",
      uri: s.uri ?? "/",
      headers: { "User-Agent": [s.ua ?? "curl/8"] },
    },
    duration: 0.01,
    size: 100,
    status: s.status ?? 200,
  });
}

const text = (specs: Spec[]) => specs.map(entry).join("\n") + "\n";

async function folder(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ce-digest-"));
}

const logging = { logs: { web: { writer: { output: "file", filename: "/var/log/caddy/web.log" } } } };
const servers = { srv0: { logs: { logger_names: { "app.example.test": ["web"], "other.example.test": ["web"], "*.wild.example.test": ["web"] } } } };
const base = { logging, servers, from: T0, to: T0 + 24 * HOUR };

const one = (digest: LogDigest) => {
  assert.equal(digest.sites.length, 1);
  return digest.sites[0];
};

describe("buildLogDigest contents", () => {
  it("summarises totals, hours, clients, denied paths, methods and user agents", async () => {
    const logDir = await folder();
    const specs: Spec[] = [
      { at: T0, status: 200, uri: "/a?token=secret", client: "198.51.100.1" },
      { at: T0 + 10 * 60_000, status: 404, uri: "/wp-login.php?x=1", client: "203.0.113.9", ua: "scanner/1" },
      { at: T0 + 11 * 60_000, status: 404, uri: "/.env", client: "203.0.113.9", ua: "scanner/1" },
      { at: T0 + 12 * 60_000, status: 403, uri: "/admin", client: "203.0.113.9", ua: "scanner/1" },
      { at: T0 + HOUR + 1000, status: 500, uri: "/boom", client: "198.51.100.1" },
      { at: T0 + HOUR + 2000, method: "PROPFIND", uri: "/dav", client: "203.0.113.9", ua: "scanner/1" },
      { at: T0 + HOUR + 3000, method: "GET", host: "unrelated.example.test" },
    ];
    await writeFile(join(logDir, "web.log"), text(specs));
    const digest = await buildLogDigest({ ...base, logDir, sites: [{ hosts: ["app.example.test"] }] });
    const site = one(digest);
    assert.equal(site.totals.requests, 6);
    assert.deepEqual(site.totals.byStatus, { "200": 2, "403": 1, "404": 2, "500": 1 });
    assert.deepEqual(site.perHour.map((h) => [h.hour, h.requests]), [[T0, 4], [T0 + HOUR, 2]]);
    assert.deepEqual(site.perHour[0].byStatus, { "200": 1, "403": 1, "404": 2 });
    assert.equal(site.topClients[0].client, "203.0.113.9");
    assert.equal(site.topClients[0].requests, 4);
    assert.equal(site.topClients[0].distinctPaths, 4);
    assert.equal(site.topClients[0].share4xx, 0.75);
    assert.deepEqual(site.unusualMethods, [{ method: "PROPFIND", requests: 1 }]);
    assert.deepEqual(site.topDeniedPaths.map((p) => p.path).sort(), ["/.env", "/admin", "/wp-login.php"]);
    assert.equal(site.topUserAgents[0].userAgent, "scanner/1");
    assert.equal(site.coverage.complete, true);
    // The digest never carries a query string, and is plain JSON.
    assert.ok(!JSON.stringify(digest).includes("secret"));
    assert.ok(!JSON.stringify(digest).includes("x=1"));
    assert.deepEqual(JSON.parse(JSON.stringify(digest)), digest);
  });

  it("ranks clients by their share of 4xx only once they have enough requests", async () => {
    const logDir = await folder();
    const specs: Spec[] = [{ at: T0, status: 404, client: "192.0.2.50" }]; // one request: too few
    for (let i = 0; i < 10; i++) specs.push({ at: T0 + i * 1000, status: i < 8 ? 404 : 200, client: "192.0.2.60", uri: `/p${i}` });
    for (let i = 0; i < 10; i++) specs.push({ at: T0 + i * 1000, status: i < 2 ? 401 : 200, client: "192.0.2.70" });
    await writeFile(join(logDir, "web.log"), text(specs));
    const site = one(await buildLogDigest({ ...base, logDir, sites: [{ hosts: ["app.example.test"] }] }));
    assert.deepEqual(site.topClientsBy4xx.map((c) => [c.client, c.share4xx, c.distinctPaths]), [["192.0.2.60", 0.8, 10], ["192.0.2.70", 0.2, 1]]);
  });

  it("limits the lists and the length of paths and user agents whatever the traffic", async () => {
    const logDir = await folder();
    const specs: Spec[] = [];
    for (let i = 0; i < 300; i++) specs.push({ at: T0 + i, status: 404, client: `192.0.2.${i % 250}`, uri: `/${"x".repeat(1000)}${i}`, ua: `agent-${i}-${"y".repeat(1000)}`, method: `M${i}` });
    await writeFile(join(logDir, "web.log"), text(specs));
    const site = one(await buildLogDigest({ ...base, logDir, sites: [{ hosts: ["app.example.test"] }] }));
    for (const list of [site.topClients, site.topClientsBy4xx, site.topDeniedPaths, site.unusualMethods, site.topUserAgents]) assert.ok(list.length <= 15);
    assert.ok(site.topDeniedPaths.every((p) => p.path.length <= 210));
    assert.ok(site.topUserAgents.every((u) => u.userAgent.length <= 210));
  });

  it("reads a file shared by several Sites once and gives each its own lines, wildcards included", async () => {
    const logDir = await folder();
    await writeFile(
      join(logDir, "web.log"),
      text([{ at: T0 }, { at: T0 + 1 }, { at: T0 + 2, host: "other.example.test" }, { at: T0 + 3, host: "a.wild.example.test" }, { at: T0 + 4, host: "nothing.example.test" }]),
    );
    const digest = await buildLogDigest({
      ...base,
      logDir,
      sites: [{ hosts: ["app.example.test"] }, { hosts: ["other.example.test", "*.wild.example.test"] }, { hosts: ["*"] }],
    });
    assert.deepEqual(digest.sites.map((s) => s.totals.requests), [2, 2]);
    const size = (await stat(join(logDir, "web.log"))).size;
    assert.equal(digest.bytesRead, size); // one pass over the file, not one per Site
    assert.deepEqual(digest.skipped.map((s) => s.reason), ["no-host"]);
  });

  it("says why a Site without a readable log is left out", async () => {
    const logDir = await folder();
    const digest = await buildLogDigest({ ...base, logDir, sites: [{ hosts: ["app.example.test"] }, { hosts: ["silent.example.test"] }] });
    assert.deepEqual(digest.sites, []);
    assert.deepEqual(digest.skipped.map((s) => s.reason), ["missing-file", "no-file-writer"]);
  });

  it("only counts lines in the period", async () => {
    const logDir = await folder();
    await writeFile(join(logDir, "web.log"), text([{ at: T0 - 1000 }, { at: T0 }, { at: T0 + HOUR }, { at: T0 + 24 * HOUR + 1000 }]));
    const site = one(await buildLogDigest({ ...base, logDir, sites: [{ hosts: ["app.example.test"] }] }));
    assert.equal(site.totals.requests, 2);
  });
});

describe("buildLogDigest across files", () => {
  it("reads rotated files, compressed ones too, and the current file", async () => {
    const logDir = await folder();
    await writeFile(join(logDir, "web-2029-12-31T20-00-00.000.log.gz"), gzipSync(text([{ at: T0 + 1 * HOUR }])));
    await writeFile(join(logDir, "web-2030-01-01T02-00-00.000.log"), text([{ at: T0 + 2 * HOUR }]));
    await writeFile(join(logDir, "web.log"), text([{ at: T0 + 3 * HOUR }, { at: T0 + 4 * HOUR }]));
    const now = new Date(T0 + 5 * HOUR);
    await utimes(join(logDir, "web-2029-12-31T20-00-00.000.log.gz"), now, new Date(T0 + HOUR + 1));
    await utimes(join(logDir, "web-2030-01-01T02-00-00.000.log"), now, new Date(T0 + 2 * HOUR + 1));
    const site = one(await buildLogDigest({ ...base, logDir, sites: [{ hosts: ["app.example.test"] }] }));
    assert.equal(site.totals.requests, 4);
    assert.deepEqual(site.perHour.map((h) => h.hour), [T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR, T0 + 4 * HOUR]);
  });

  it("does not count a rotation twice while its compression is still running", async () => {
    const logDir = await folder();
    const body = text([{ at: T0 + HOUR }]);
    await writeFile(join(logDir, "web-2030-01-01T02-00-00.000.log"), body);
    await writeFile(join(logDir, "web-2030-01-01T02-00-00.000.log.gz"), gzipSync(body));
    for (const name of ["web-2030-01-01T02-00-00.000.log", "web-2030-01-01T02-00-00.000.log.gz"]) await utimes(join(logDir, name), new Date(T0 + 2 * HOUR), new Date(T0 + 2 * HOUR));
    await writeFile(join(logDir, "web.log"), text([{ at: T0 + 3 * HOUR }]));
    const site = one(await buildLogDigest({ ...base, logDir, sites: [{ hosts: ["app.example.test"] }] }));
    assert.equal(site.totals.requests, 2);
  });

  it("reports a period that starts before the oldest line kept as partly unseen", async () => {
    const logDir = await folder();
    await writeFile(join(logDir, "web.log"), text([{ at: T0 + 6 * HOUR }, { at: T0 + 7 * HOUR }]));
    const site = one(await buildLogDigest({ ...base, logDir, sites: [{ hosts: ["app.example.test"] }] }));
    assert.equal(site.coverage.complete, false);
    assert.deepEqual(site.coverage.unseen, [{ from: T0, to: T0 + 6 * HOUR, reason: "rotated-away", file: "web.log" }]);
    assert.deepEqual(site.coverage.covered, [{ from: T0 + 6 * HOUR, to: T0 + 24 * HOUR }]);
  });

  it("does not report a gap when older rotated files exist but end before the period", async () => {
    const logDir = await folder();
    const old = join(logDir, "web-2029-12-30T00-00-00.000.log");
    await writeFile(old, text([{ at: T0 - 30 * HOUR }]));
    await utimes(old, new Date(T0 - 24 * HOUR), new Date(T0 - 24 * HOUR));
    await writeFile(join(logDir, "web.log"), text([{ at: T0 + 6 * HOUR }]));
    const site = one(await buildLogDigest({ ...base, logDir, sites: [{ hosts: ["app.example.test"] }] }));
    assert.equal(site.coverage.complete, true);
    assert.equal(site.totals.requests, 1);
  });

  it("stops at the size limit, newest first, and states the part it did not see", async () => {
    const logDir = await folder();
    const rotated = join(logDir, "web-2030-01-01T10-00-00.000.log");
    await writeFile(rotated, text([{ at: T0 + 1 * HOUR }, { at: T0 + 2 * HOUR }]));
    await utimes(rotated, new Date(T0 + 10 * HOUR), new Date(T0 + 10 * HOUR));
    const current = text([{ at: T0 + 12 * HOUR }, { at: T0 + 13 * HOUR }, { at: T0 + 14 * HOUR }]);
    await writeFile(join(logDir, "web.log"), current);
    const maxBytes = Buffer.byteLength(current) + 10; // the current file fits, the rotated one does not
    const digest = await buildLogDigest({ ...base, logDir, sites: [{ hosts: ["app.example.test"] }], maxBytes });
    const site = one(digest);
    assert.equal(site.totals.requests, 3);
    assert.ok(digest.bytesRead <= maxBytes);
    assert.equal(site.coverage.complete, false);
    assert.deepEqual(site.coverage.unseen.map((u) => [u.from, u.to, u.reason]), [[T0, T0 + 12 * HOUR, "size-limit"]]);
    assert.deepEqual(site.coverage.covered, [{ from: T0 + 12 * HOUR, to: T0 + 24 * HOUR }]);
  });

  it("reads part of a file that alone is over the limit and says what is missing after it", async () => {
    const logDir = await folder();
    const lines = [0, 1, 2, 3, 4, 5].map((i) => ({ at: T0 + (i + 1) * HOUR }));
    await writeFile(join(logDir, "web.log"), text(lines));
    const maxBytes = Buffer.byteLength(entry(lines[0])) * 3 + 10;
    const site = one(await buildLogDigest({ ...base, logDir, sites: [{ hosts: ["app.example.test"] }], maxBytes }));
    assert.ok(site.totals.requests >= 1 && site.totals.requests < 6);
    const unseen = site.coverage.unseen.map((u) => u.reason);
    assert.ok(unseen.includes("size-limit"));
    assert.equal(site.coverage.complete, false);
  });
});

describe("buildLogDigest on a large log", () => {
  it("summarises a log far larger than the Logs tab reads, without holding it in memory", async () => {
    const logDir = await folder();
    const path = join(logDir, "web.log");
    const out = createWriteStream(path);
    const total = 120_000;
    const one = entry({ at: T0 });
    for (let i = 0; i < total; i++) {
      const line = i % 2 === 0 ? one : entry({ at: T0 + 12 * HOUR, status: 404, uri: `/scan/${i}?q=${i}`, client: `192.0.2.${i % 200}` });
      if (!out.write(line + "\n")) await new Promise((r) => out.once("drain", r));
    }
    await new Promise<void>((r) => out.end(r));
    const size = (await stat(path)).size;
    assert.ok(size > 30 * 1024 * 1024, "the fixture is bigger than the Logs tab's 8 MiB read window");
    const digest = await buildLogDigest({ ...base, logDir, sites: [{ hosts: ["app.example.test"] }] });
    const site = digest.sites[0];
    assert.equal(site.totals.requests, total);
    assert.equal(site.totals.byStatus["404"], total / 2);
    assert.equal(digest.bytesRead, size);
    assert.ok(JSON.stringify(digest).length < 20_000);
  });
});

describe("GET /api/log-digest", () => {
  async function rig(login: boolean) {
    const dir = await folder();
    const socket = join(dir, "admin.sock");
    const caddy = createServer((req, res) => {
      const send = (body: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      req.resume();
      if (req.url === "/config/apps/http/servers") {
        return send({ srv0: { listen: [":443"], logs: servers.srv0.logs, routes: [{ match: [{ host: ["app.example.test"] }], handle: [{ handler: "static_response", body: "hi" }] }] } });
      }
      if (req.url === "/config/logging") return send(logging);
      send({});
    });
    await new Promise<void>((r) => caddy.listen(socket, r));
    const logDir = join(dir, "logs");
    await (await import("node:fs/promises")).mkdir(logDir);
    await writeFile(join(logDir, "web.log"), text([{ at: T0 + HOUR }]));
    const caddyfile = join(dir, "Caddyfile");
    await writeFile(caddyfile, "app.example.test {\n\trespond hi\n}\n");
    const config = loadConfig({
      ADMIN_SOCKET: socket,
      CADDYFILE_PATH: caddyfile,
      DATA_DIR: join(dir, "data"),
      LOG_DIR: logDir,
      WEB_ROOT: dir,
      ...(login && { AUTH_USER: "owner", AUTH_PASSWORD: "correct horse battery" }),
    });
    const shutdown: Array<() => Promise<void>> = [];
    const app = await createApp(config, shutdown);
    return {
      app,
      async cleanup() {
        await Promise.allSettled(shutdown.map((fn) => fn()));
        await new Promise<void>((r) => caddy.close(() => r()));
      },
    };
  }

  it("needs a Session when a login is set, and returns the digest with one", async () => {
    const r = await rig(true);
    try {
      const url = `/api/log-digest?from=${T0}&to=${T0 + 24 * HOUR}`;
      assert.equal((await r.app.request(url)).status, 401);
      const login = await r.app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "owner", password: "correct horse battery" }) });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
      const reply = await r.app.request(url, { headers: { Cookie: cookie } });
      assert.equal(reply.status, 200);
      const body = (await reply.json()) as { ok: boolean; digest: LogDigest };
      assert.equal(body.digest.sites[0].totals.requests, 1);
      const one = await r.app.request(`${url}&host=app.example.test`, { headers: { Cookie: cookie } });
      assert.equal(one.status, 200);
      assert.equal((await r.app.request(`${url}&host=nope.example.test`, { headers: { Cookie: cookie } })).status, 404);
      assert.equal((await r.app.request(`/api/log-digest?from=5&to=1`, { headers: { Cookie: cookie } })).status, 400);
    } finally {
      await r.cleanup();
    }
  });
});
