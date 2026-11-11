import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";

const servers = readFileSync(new URL("./fixtures/sample.servers.json", import.meta.url), "utf8");
const SECRET_PATH = "/topic/very-secret-topic";

const listen = (server: Server, where: string | number) => new Promise<void>((resolve) => server.listen(where, resolve));
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/** A Caddy stand-in that answers what the watcher and the routes view ask for. */
function fakeCaddy() {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const send = (status: number, text: string) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(text);
      };
      if (req.url === "/config/") return send(200, "{}");
      if (req.url === "/config/apps/http/servers") return send(200, servers);
      if (req.url === "/metrics") return send(200, 'caddy_reverse_proxy_upstreams_healthy{upstream="10.0.0.5:4000"} 1\n');
      if (req.url === "/adapt") return send(200, JSON.stringify({ result: {}, warnings: [] }));
      if (req.url === "/load") return body.includes("LOADFAIL") ? send(400, '{"error":"port in use"}') : send(200, "{}");
      send(404, "{}");
    });
  });
}

async function rig(webhook: boolean, webhookStatus = 200) {
  const dir = await mkdtemp(join(tmpdir(), "ce-events-"));
  const socket = join(dir, "admin.sock");
  const caddy = fakeCaddy();
  await listen(caddy, socket);
  const received: unknown[] = [];
  const hook = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ path: req.url, title: req.headers.title, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(webhookStatus);
      res.end();
    });
  });
  await listen(hook, 0);
  const hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}${SECRET_PATH}`;
  const caddyfile = join(dir, "Caddyfile");
  await writeFile(caddyfile, "example.com {\n\trespond hi\n}\n");
  const config = loadConfig({
    ADMIN_SOCKET: socket,
    CADDYFILE_PATH: caddyfile,
    DATA_DIR: join(dir, "data"),
    LOG_DIR: dir,
    WEB_ROOT: dir,
    ...(webhook && { NTFY_URL: hookUrl, NTFY_TOKEN: "tk_very_secret" }),
  });
  const shutdown: Array<() => Promise<void>> = [];
  const app = await createApp(config, shutdown);
  const get = async (path: string) => app.request(path);
  return {
    app,
    received,
    hookUrl,
    get,
    async cleanup() {
      await Promise.allSettled(shutdown.map((fn) => fn()));
      await close(caddy);
      await close(hook);
    },
  };
}

const failedDeploy = (app: Awaited<ReturnType<typeof rig>>["app"], hash: string) =>
  app.request("/api/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "LOADFAIL {\n}\n", baseHash: hash }),
  });

async function deployAndWait(r: Awaited<ReturnType<typeof rig>>) {
  const current = (await (await r.get("/api/caddyfile")).json()) as { hash: string };
  const reply = await failedDeploy(r.app, current.hash);
  assert.equal(reply.status, 502);
  for (let i = 0; i < 50 && r.received.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
}

test("a refused reload is in the history and reaches ntfy", async () => {
  const r = await rig(true);
  try {
    await deployAndWait(r);
    const history = (await (await r.get("/api/events")).json()) as { alerts: boolean; events: Array<{ kind: string }> };
    assert.equal(history.alerts, true);
    assert.equal(history.events.some((e) => e.kind === "deploy_failed"), true);
    assert.equal(r.received.length, 1);
    const hit = r.received[0] as { path: string; title: string; authorization: string; body: string };
    assert.equal(hit.path, SECRET_PATH);
    assert.equal(hit.title, "Fairway: deploy failed");
    assert.equal(hit.authorization, "Bearer tk_very_secret");
    assert.match(hit.body, /refused the reload/);
  } finally {
    await r.cleanup();
  }
});

test("the status says whether alerting is on and never where it goes", async () => {
  const on = await rig(true);
  const off = await rig(false);
  try {
    assert.deepEqual(await (await on.get("/api/alerts")).json(), { ok: true, enabled: true });
    assert.deepEqual(await (await off.get("/api/alerts")).json(), { ok: true, enabled: false });
    await deployAndWait(on);
    for (const path of ["/api/alerts", "/api/events", "/api/status"]) {
      const text = await (await on.get(path)).text();
      assert.doesNotMatch(text, /very-secret-topic|tk_very_secret|127\.0\.0\.1/, path);
    }
    const test = await on.app.request("/api/alerts/test", { method: "POST" });
    assert.doesNotMatch(await test.text(), /very-secret-topic|tk_very_secret/);
  } finally {
    await on.cleanup();
    await off.cleanup();
  }
});

test("Send test reaches ntfy marked as a test and is not recorded", async () => {
  const r = await rig(true);
  try {
    const reply = await r.app.request("/api/alerts/test", { method: "POST" });
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), { ok: true });
    assert.equal((r.received[0] as { title: string }).title, "Fairway: test");
    const history = (await (await r.get("/api/events")).json()) as { events: Array<{ kind: string }> };
    assert.equal(history.events.some((e) => e.kind !== "state"), false);
  } finally {
    await r.cleanup();
  }
});

test("Send test says so when no topic is set or ntfy refuses", async () => {
  const none = await rig(false);
  const refusing = await rig(true, 500);
  try {
    const a = await none.app.request("/api/alerts/test", { method: "POST" });
    assert.equal(a.status, 502);
    assert.equal(((await a.json()) as { ok: boolean }).ok, false);
    const b = await refusing.app.request("/api/alerts/test", { method: "POST" });
    const body = (await b.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /500/);
    assert.doesNotMatch(body.error, /very-secret-topic|tk_very_secret/);
  } finally {
    await none.cleanup();
    await refusing.cleanup();
  }
});

test("the timeline lists every host of the running config", async () => {
  const r = await rig(false);
  try {
    const reply = (await (await r.get("/api/events/timeline?window=3600")).json()) as {
      ok: boolean;
      from: number;
      to: number;
      hosts: Record<string, Array<{ from: number; to: number; state: string }>>;
    };
    assert.equal(reply.ok, true);
    assert.ok("app.example.com" in reply.hosts);
    for (const intervals of Object.values(reply.hosts)) {
      assert.equal(intervals[0].from, reply.from);
      assert.equal(intervals.at(-1)!.to, reply.to);
    }
  } finally {
    await r.cleanup();
  }
});

test("history can be filtered by Subject", async () => {
  const r = await rig(false);
  try {
    let caddy: Array<{ subject?: string }> = [];
    for (let i = 0; i < 50 && caddy.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      caddy = ((await (await r.get("/api/events?subject=caddy")).json()) as { events: Array<{ subject?: string }> }).events;
    }
    assert.equal(caddy.length, 1); // the first sighting of Caddy answering
    assert.equal(caddy[0].subject, "caddy");
    const other = (await (await r.get("/api/events?subject=cert:nothing.test")).json()) as { events: unknown[] };
    assert.equal(other.events.length, 0);
  } finally {
    await r.cleanup();
  }
});
