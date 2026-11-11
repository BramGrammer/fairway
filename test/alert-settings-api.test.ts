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
const listen = (server: Server, where: string | number) => new Promise<void>((resolve) => server.listen(where, resolve));
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

function fakeCaddy() {
  return createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const send = (status: number, text: string) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(text);
      };
      if (req.url === "/config/") return send(200, "{}");
      if (req.url === "/config/apps/http/servers") return send(200, servers);
      if (req.url === "/adapt") return send(200, JSON.stringify({ result: {}, warnings: [] }));
      if (req.url === "/load") return send(400, '{"error":"port in use"}');
      send(404, "{}");
    });
  });
}

/** A stand-in for an ntfy server that remembers what it was sent. */
async function fakeNtfy() {
  const received: Array<{ path: string; title?: string; authorization?: string; body: string }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", title: req.headers.title as string | undefined, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200);
      res.end();
    });
  });
  await listen(server, 0);
  const url = (path: string) => `http://127.0.0.1:${(server.address() as { port: number }).port}${path}`;
  return { received, url, close: () => close(server) };
}

async function rig(options: { login: boolean; env?: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "ce-settings-"));
  const socket = join(dir, "admin.sock");
  const caddy = fakeCaddy();
  await listen(caddy, socket);
  const envNtfy = await fakeNtfy();
  const extra = await fakeNtfy();
  const caddyfile = join(dir, "Caddyfile");
  await writeFile(caddyfile, "example.com {\n\trespond hi\n}\n");
  const config = loadConfig({
    ADMIN_SOCKET: socket,
    CADDYFILE_PATH: caddyfile,
    DATA_DIR: join(dir, "data"),
    LOG_DIR: dir,
    WEB_ROOT: dir,
    ...(options.env !== false && { NTFY_URL: envNtfy.url("/env-secret-topic"), NTFY_TOKEN: "tk_env_secret" }),
    ...(options.login && { AUTH_USER: "owner", AUTH_PASSWORD: "correct horse battery" }),
  });
  const shutdown: Array<() => Promise<void>> = [];
  const app = await createApp(config, shutdown);
  let cookie = "";
  if (options.login) {
    const res = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "owner", password: "correct horse battery" }) });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    assert.equal(res.status, 200);
  }
  const call = (method: string, path: string, body?: unknown, signedIn = true) =>
    app.request(path, { method, headers: { "Content-Type": "application/json", ...(cookie && signedIn && { Cookie: cookie }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  return {
    call,
    envNtfy,
    extra,
    async json(method: string, path: string, body?: unknown) {
      const res = await call(method, path, body);
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    },
    async refuseDeploy() {
      const current = (await (await call("GET", "/api/caddyfile")).json()) as { hash: string };
      const res = await call("POST", "/api/deploy", { text: "LOADFAIL {\n}\n", baseHash: current.hash });
      assert.equal(res.status, 502);
      await new Promise((resolve) => setTimeout(resolve, 150));
    },
    async cleanup() {
      await Promise.allSettled(shutdown.map((fn) => fn()));
      await close(caddy);
      await envNtfy.close();
      await extra.close();
    },
  };
}

test("the settings start from the environment and never show an address or a token", async () => {
  const r = await rig({ login: true });
  try {
    const { status, body } = await r.json("GET", "/api/settings/alerts");
    assert.equal(status, 200);
    assert.equal(body.canEditSecrets, true);
    assert.equal(body.topics.length, 1);
    assert.deepEqual([body.topics[0].source, body.topics[0].enabled, body.topics[0].hasToken], ["env", true, true]);
    assert.equal(body.triggers.rollback.value, false);
    assert.equal(body.timing.caddyHoldSec.value, 15);
    assert.doesNotMatch(JSON.stringify(body), /env-secret-topic|tk_env_secret/);
  } finally {
    await r.cleanup();
  }
});

test("a topic added in the interface receives Alerts at once, with its own token", async () => {
  const r = await rig({ login: true, env: false });
  try {
    const added = await r.json("POST", "/api/settings/alerts/topics", { name: "Phone", url: r.extra.url("/phone-secret-topic"), token: "tk_phone_secret" });
    assert.equal(added.status, 200);
    assert.equal(added.body.topics.length, 1);
    assert.doesNotMatch(JSON.stringify(added.body), /phone-secret-topic|tk_phone_secret/);
    assert.equal(((await r.json("GET", "/api/alerts")).body as { enabled: boolean }).enabled, true);

    await r.refuseDeploy();
    assert.equal(r.extra.received.length, 1);
    assert.equal(r.extra.received[0].path, "/phone-secret-topic");
    assert.equal(r.extra.received[0].authorization, "Bearer tk_phone_secret");
    assert.equal(r.extra.received[0].title, "Fairway: deploy failed");
  } finally {
    await r.cleanup();
  }
});

test("switching a trigger off stops its Alerts without a restart; resetting brings them back", async () => {
  const r = await rig({ login: true });
  try {
    assert.equal((await r.json("PUT", "/api/settings/alerts", { triggers: { deploy_failed: false } })).body.triggers.deploy_failed.overridden, true);
    await r.refuseDeploy();
    assert.equal(r.envNtfy.received.length, 0);
    await r.json("PUT", "/api/settings/alerts", { triggers: { deploy_failed: null } });
    await r.refuseDeploy();
    assert.equal(r.envNtfy.received.length, 1);
  } finally {
    await r.cleanup();
  }
});

test("a topic from the environment can be switched off and on, and tested on its own", async () => {
  const r = await rig({ login: true });
  try {
    const id = (await r.json("GET", "/api/settings/alerts")).body.topics[0].id as string;
    assert.equal((await r.json("PATCH", `/api/settings/alerts/topics/${id}`, { enabled: false })).body.topics[0].enabled, false);
    assert.equal(((await r.json("GET", "/api/alerts")).body as { enabled: boolean }).enabled, false);
    await r.refuseDeploy();
    assert.equal(r.envNtfy.received.length, 0);

    const test = await r.json("POST", "/api/alerts/test", { id });
    assert.deepEqual(test.body, { ok: true });
    assert.equal(r.envNtfy.received.length, 1);
    assert.equal(r.envNtfy.received[0].title, "Fairway: test");
    assert.equal((await r.json("POST", "/api/alerts/test", { id: "nope" })).status, 404);

    assert.equal((await r.json("PATCH", `/api/settings/alerts/topics/${id}`, { url: "https://x.example.test" })).status, 400);
    assert.equal((await r.json("DELETE", `/api/settings/alerts/topics/${id}`)).status, 400);
  } finally {
    await r.cleanup();
  }
});

test("bad values are refused with a reason and change nothing", async () => {
  const r = await rig({ login: true });
  try {
    for (const body of [{ timing: { caddyHoldSec: 1 } }, { triggers: { cert: "yes" } }, { publicUrl: "javascript:alert(1)" }]) {
      const res = await r.json("PUT", "/api/settings/alerts", body);
      assert.equal(res.status, 400);
      assert.equal(res.body.ok, false);
    }
    assert.equal((await r.json("POST", "/api/settings/alerts/topics", { name: "", url: "nope" })).status, 400);
    assert.equal((await r.json("GET", "/api/settings/alerts")).body.timing.caddyHoldSec.value, 15);
    assert.equal((await r.call("PUT", "/api/settings/alerts", undefined)).status, 400);
  } finally {
    await r.cleanup();
  }
});

test("with no login the addresses and tokens cannot be changed, but the switches can", async () => {
  const r = await rig({ login: false });
  try {
    const view = (await r.json("GET", "/api/settings/alerts")).body;
    assert.equal(view.canEditSecrets, false);
    assert.equal("host" in view.topics[0], false);
    assert.equal((await r.json("POST", "/api/settings/alerts/topics", { name: "x", url: "https://a.example.test" })).status, 403);
    const id = view.topics[0].id as string;
    assert.equal((await r.json("PATCH", `/api/settings/alerts/topics/${id}`, { url: "https://a.example.test" })).status, 403);
    assert.equal((await r.json("PATCH", `/api/settings/alerts/topics/${id}`, { token: "x" })).status, 403);
    assert.equal((await r.json("DELETE", `/api/settings/alerts/topics/${id}`)).status, 403);

    assert.equal((await r.json("PUT", "/api/settings/alerts", { triggers: { rollback: true } })).status, 200);
    assert.equal((await r.json("PATCH", `/api/settings/alerts/topics/${id}`, { enabled: false })).status, 200);
  } finally {
    await r.cleanup();
  }
});

test("with a login the host name of each topic is shown, never its address", async () => {
  const r = await rig({ login: true });
  try {
    const topic = (await r.json("GET", "/api/settings/alerts")).body.topics[0];
    assert.equal(topic.host, r.envNtfy.url("/").replace("http://", "").replace(/\/$/, ""));
  } finally {
    await r.cleanup();
  }
});

test("the settings need a login when one is set", async () => {
  const r = await rig({ login: true });
  try {
    for (const [method, path] of [
      ["GET", "/api/settings/alerts"],
      ["PUT", "/api/settings/alerts"],
      ["POST", "/api/settings/alerts/topics"],
      ["POST", "/api/alerts/test"],
    ]) {
      const res = await r.call(method, path, method === "GET" ? undefined : {}, false);
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  } finally {
    await r.cleanup();
  }
});

test("a host can be switched on, narrowed and snoozed, with or without a login", async () => {
  for (const login of [false, true]) {
    const r = await rig({ login });
    try {
      assert.deepEqual((await r.json("GET", "/api/settings/alerts")).body.hosts, {});
      const on = await r.json("PUT", "/api/settings/alerts", { hosts: { "app.example.com": { enabled: true, kinds: { cert: false }, snoozeMinutes: 30 } } });
      assert.equal(on.status, 200);
      const host = on.body.hosts["app.example.com"];
      assert.deepEqual([host.enabled, host.kinds], [true, { cert: false, host: true, upstream: true }]);
      assert.ok(host.snoozedUntil > Date.now());
      const cleared = await r.json("PUT", "/api/settings/alerts", { hosts: { "app.example.com": { snoozeMinutes: null } } });
      assert.equal(cleared.body.hosts["app.example.com"].snoozedUntil, null);
      assert.deepEqual((await r.json("PUT", "/api/settings/alerts", { hosts: { "app.example.com": null } })).body.hosts, {});
      assert.equal((await r.json("PUT", "/api/settings/alerts", { hosts: { "app.example.com": { snoozeMinutes: 0 } } })).status, 400);
    } finally {
      await r.cleanup();
    }
  }
});
