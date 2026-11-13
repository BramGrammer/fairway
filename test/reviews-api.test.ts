import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";

async function rig(options: { login: boolean; model?: string }) {
  const dir = await mkdtemp(join(tmpdir(), "ce-reviews-api-"));
  const caddyfile = join(dir, "Caddyfile");
  await writeFile(caddyfile, "example.com {\n\trespond hi\n}\n");
  const config = loadConfig({
    ADMIN_SOCKET: join(dir, "missing.sock"),
    CADDYFILE_PATH: caddyfile,
    DATA_DIR: join(dir, "data"),
    LOG_DIR: dir,
    WEB_ROOT: dir,
    ...(options.model && { AI_REVIEW_MODEL: options.model }),
    ...(options.login && { AUTH_USER: "owner", AUTH_PASSWORD: "correct horse battery" }),
  });
  const shutdown: Array<() => Promise<void>> = [];
  const app = await createApp(config, shutdown);
  let cookie = "";
  if (options.login) {
    const res = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "owner", password: "correct horse battery" }) });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  }
  return {
    async call(method: string, path: string, signedIn = true) {
      const res = await app.request(path, { method, headers: { ...(cookie && signedIn && { Cookie: cookie }) } });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    },
    cleanup: () => Promise.allSettled(shutdown.map((fn) => fn())),
  };
}

test("Reviews are behind the Session", async () => {
  const r = await rig({ login: true, model: "made-up-model" });
  for (const [method, path] of [["GET", "/api/reviews"], ["POST", "/api/reviews"], ["GET", "/api/reviews/1"]]) assert.equal((await r.call(method, path, false)).status, 401, path);
  await r.cleanup();
});

test("starting a Review is refused without a login and without a model, with a reason", async () => {
  const open = await rig({ login: false, model: "made-up-model" });
  const noLogin = await open.call("POST", "/api/reviews");
  assert.equal(noLogin.status, 403);
  assert.match(noLogin.body.error, /Sign in/);
  const bare = await rig({ login: true });
  const noModel = await bare.call("POST", "/api/reviews");
  assert.equal(noModel.status, 400);
  assert.match(noModel.body.error, /model/);
  await open.cleanup();
  await bare.cleanup();
});

test("a started Review is listed and can be fetched; an unknown one is 404", async () => {
  const r = await rig({ login: true, model: "made-up-model" });
  // Sent together, so the first is still running when the second arrives.
  const [started, second] = await Promise.all([r.call("POST", "/api/reviews"), r.call("POST", "/api/reviews")]);
  assert.equal(started.status, 202);
  assert.equal(started.body.review.status, "running");
  assert.equal(second.status, 409);
  const list = await r.call("GET", "/api/reviews");
  assert.equal(list.body.reviews[0].id, started.body.review.id);
  assert.equal((await r.call("GET", `/api/reviews/${started.body.review.id}`)).status, 200);
  assert.equal((await r.call("GET", "/api/reviews/999")).status, 404);
  await r.cleanup();
});
