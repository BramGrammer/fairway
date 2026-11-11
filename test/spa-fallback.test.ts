import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";

const SHELL = "<!doctype html><title>shell</title>";

async function rig() {
  const dir = await mkdtemp(join(tmpdir(), "ce-spa-"));
  const web = join(dir, "web");
  await mkdir(join(web, "assets"), { recursive: true });
  await writeFile(join(web, "index.html"), SHELL);
  await writeFile(join(web, "assets", "app.js"), "console.log(1);");
  const socket = join(dir, "admin.sock");
  const caddy = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => caddy.listen(socket, resolve));
  await writeFile(join(dir, "Caddyfile"), "example.com {\n\trespond hi\n}\n");
  const config = loadConfig({
    ADMIN_SOCKET: socket,
    CADDYFILE_PATH: join(dir, "Caddyfile"),
    DATA_DIR: join(dir, "data"),
    LOG_DIR: dir,
    WEB_ROOT: web,
    AUTH_USER: "owner",
    AUTH_PASSWORD: "pw-for-tests",
  });
  const shutdown: Array<() => Promise<void>> = [];
  const app = await createApp(config, shutdown);
  return {
    app,
    async cleanup() {
      await Promise.allSettled(shutdown.map((fn) => fn()));
      await new Promise<void>((resolve) => caddy.close(() => resolve()));
    },
  };
}

test("SPA fallback", async (t) => {
  const r = await rig();
  t.after(() => r.cleanup());

  for (const path of ["/", "/routes", "/editor", "/history", "/routes/anything/deeper"]) {
    await t.test(`${path} serves the shell without a session`, async () => {
      const res = await r.app.request(path);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
      assert.equal(await res.text(), SHELL);
      if (path !== "/") assert.equal(res.headers.get("cache-control"), "no-cache");
    });
  }

  await t.test("a real file is served as is", async () => {
    const res = await r.app.request("/assets/app.js");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "console.log(1);");
  });

  for (const path of ["/assets/missing.js", "/missing.png", "/favicon.ico"]) {
    await t.test(`${path} is a plain 404`, async () => {
      const res = await r.app.request(path);
      assert.equal(res.status, 404);
      assert.doesNotMatch(await res.text(), /<html|<!doctype/i);
    });
  }

  await t.test("an unknown /api path is a 404 that is not HTML", async () => {
    const res = await r.app.request("/api/does-not-exist");
    assert.ok(res.status === 404 || res.status === 401);
    assert.doesNotMatch(await res.text(), /<html|<!doctype/i);
  });

  await t.test("a POST to a page address is not answered with HTML", async () => {
    const res = await r.app.request("/routes", { method: "POST" });
    assert.notEqual(await res.text(), SHELL);
    assert.equal(res.status, 404);
  });
});
