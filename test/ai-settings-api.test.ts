import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";

const KEY_ENV = "sk-env-made-up-key";
const KEY_SAVED = "sk-saved-made-up-key";

const listen = (server: Server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/** A stand-in for a model endpoint that only accepts one key and remembers what it was asked. */
async function fakeModels(accepts: string) {
  const asked: Array<{ url?: string; authorization?: string }> = [];
  const server = createServer((req, res) => {
    asked.push({ url: req.url, authorization: req.headers.authorization });
    const ok = req.headers.authorization === `Bearer ${accepts}`;
    res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ok ? { data: [{ id: "model-a" }] } : { error: "no" }));
  });
  await listen(server);
  return { asked, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => close(server) };
}

async function rig(options: { login: boolean; env?: { baseUrl: string; key: string; assistantModel?: string; reviewModel?: string } }) {
  const dir = await mkdtemp(join(tmpdir(), "ce-ai-api-"));
  const caddyfile = join(dir, "Caddyfile");
  await writeFile(caddyfile, "example.com {\n\trespond hi\n}\n");
  const config = loadConfig({
    ADMIN_SOCKET: join(dir, "missing.sock"),
    CADDYFILE_PATH: caddyfile,
    DATA_DIR: join(dir, "data"),
    LOG_DIR: dir,
    WEB_ROOT: dir,
    ...(options.env && { AI_BASE_URL: options.env.baseUrl, AI_API_KEY: options.env.key, ...(options.env.assistantModel && { AI_ASSISTANT_MODEL: options.env.assistantModel }), ...(options.env.reviewModel && { AI_REVIEW_MODEL: options.env.reviewModel }) }),
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
    dir,
    async call(method: string, path: string, body?: unknown, signedIn = true) {
      const res = await app.request(path, { method, headers: { "Content-Type": "application/json", ...(cookie && signedIn && { Cookie: cookie }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
      return { status: res.status, text: await res.clone().text(), body: (await res.json()) as Record<string, any> };
    },
    cleanup: () => Promise.allSettled(shutdown.map((fn) => fn())),
  };
}

test("the settings start from the environment and the key is only reported as set", async () => {
  const r = await rig({ login: true, env: { baseUrl: "https://llm.example.test/v1", key: KEY_ENV } });
  try {
    const { status, body, text } = await r.call("GET", "/api/settings/ai");
    assert.equal(status, 200);
    assert.equal(body.canEdit, true);
    assert.deepEqual(body.baseUrl, { value: "https://llm.example.test/v1", default: "https://llm.example.test/v1", overridden: false });
    assert.deepEqual(body.apiKey, { set: true, source: "env", overridden: false });
    assert.doesNotMatch(text, new RegExp(KEY_ENV));
  } finally {
    await r.cleanup();
  }
});

test("with nothing configured the address is OpenRouter's and no key is set", async () => {
  const r = await rig({ login: true });
  try {
    const { body } = await r.call("GET", "/api/settings/ai");
    assert.equal(body.baseUrl.value, "https://openrouter.ai/api/v1");
    assert.equal(body.apiKey.set, false);
  } finally {
    await r.cleanup();
  }
});

test("a saved address and key win, are marked changed, never come back, and can be reset", async () => {
  const r = await rig({ login: true, env: { baseUrl: "https://llm.example.test/v1", key: KEY_ENV } });
  try {
    const saved = await r.call("PUT", "/api/settings/ai", { baseUrl: "http://localhost:11434/v1", apiKey: KEY_SAVED });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.baseUrl.value, "http://localhost:11434/v1");
    assert.equal(saved.body.baseUrl.overridden, true);
    assert.deepEqual(saved.body.apiKey, { set: true, source: "saved", overridden: true });
    assert.doesNotMatch(saved.text, new RegExp(`${KEY_SAVED}|${KEY_ENV}`));
    assert.doesNotMatch((await r.call("GET", "/api/settings/ai")).text, new RegExp(KEY_SAVED));

    const reset = await r.call("PUT", "/api/settings/ai", { baseUrl: null, apiKey: null });
    assert.equal(reset.body.baseUrl.value, "https://llm.example.test/v1");
    assert.deepEqual(reset.body.apiKey, { set: true, source: "env", overridden: false });
  } finally {
    await r.cleanup();
  }
});

test("the key is stored in the data folder with mode 0600", async () => {
  const r = await rig({ login: true });
  try {
    await r.call("PUT", "/api/settings/ai", { apiKey: KEY_SAVED });
    const file = join(r.dir, "data", "ai-settings.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.match(await readFile(file, "utf8"), new RegExp(KEY_SAVED));
  } finally {
    await r.cleanup();
  }
});

test("a bad address is refused with 400", async () => {
  const r = await rig({ login: true });
  try {
    assert.equal((await r.call("PUT", "/api/settings/ai", { baseUrl: "not an address" })).status, 400);
    assert.equal((await r.call("PUT", "/api/settings/ai", { apiKey: "two words" })).status, 400);
  } finally {
    await r.cleanup();
  }
});

test("without a login the address and key cannot be set, and the settings say so", async () => {
  const r = await rig({ login: false, env: { baseUrl: "https://llm.example.test/v1", key: KEY_ENV } });
  try {
    assert.equal((await r.call("GET", "/api/settings/ai")).body.canEdit, false);
    for (const change of [{ baseUrl: "https://evil.example.test/v1" }, { apiKey: KEY_SAVED }, { baseUrl: null }]) {
      const res = await r.call("PUT", "/api/settings/ai", change);
      assert.equal(res.status, 403);
      assert.match(res.body.error, /Sign in is required/);
    }
    assert.equal((await r.call("GET", "/api/settings/ai")).body.baseUrl.value, "https://llm.example.test/v1");
  } finally {
    await r.cleanup();
  }
});

test("with a login required, signed-out requests are refused", async () => {
  const r = await rig({ login: true });
  try {
    assert.equal((await r.call("GET", "/api/settings/ai", undefined, false)).status, 401);
    assert.equal((await r.call("PUT", "/api/settings/ai", { apiKey: KEY_SAVED }, false)).status, 401);
    assert.equal((await r.call("POST", "/api/settings/ai/test", {}, false)).status, 401);
  } finally {
    await r.cleanup();
  }
});

test("the test call reaches the saved address with the saved key and reports success", async () => {
  const models = await fakeModels(KEY_SAVED);
  const r = await rig({ login: true });
  try {
    await r.call("PUT", "/api/settings/ai", { baseUrl: models.url, apiKey: KEY_SAVED });
    const res = await r.call("POST", "/api/settings/ai/test", {});
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, models: 1 });
    assert.deepEqual(models.asked, [{ url: "/v1/models", authorization: `Bearer ${KEY_SAVED}` }]);
  } finally {
    await r.cleanup();
    await models.close();
  }
});

test("the test call uses the environment's values until something is saved, and says when the key is refused", async () => {
  const models = await fakeModels(KEY_ENV);
  const r = await rig({ login: true, env: { baseUrl: models.url, key: KEY_ENV } });
  try {
    assert.equal((await r.call("POST", "/api/settings/ai/test", {})).status, 200);
    await r.call("PUT", "/api/settings/ai", { apiKey: KEY_SAVED });
    const refused = await r.call("POST", "/api/settings/ai/test", {});
    assert.equal(refused.status, 502);
    assert.equal(refused.body.reason, "key_refused");
    assert.doesNotMatch(refused.text, new RegExp(`${KEY_SAVED}|${KEY_ENV}`));
  } finally {
    await r.cleanup();
    await models.close();
  }
});

test("the test call reports an unreachable endpoint without the key", async () => {
  const models = await fakeModels(KEY_SAVED);
  const url = models.url;
  await models.close();
  const r = await rig({ login: true });
  try {
    await r.call("PUT", "/api/settings/ai", { baseUrl: url, apiKey: KEY_SAVED });
    const res = await r.call("POST", "/api/settings/ai/test", {});
    assert.equal(res.status, 502);
    assert.equal(res.body.reason, "unreachable");
    assert.doesNotMatch(res.text, new RegExp(KEY_SAVED));
  } finally {
    await r.cleanup();
  }
});

test("what was saved survives a restart", async () => {
  const r = await rig({ login: true });
  try {
    await r.call("PUT", "/api/settings/ai", { baseUrl: "https://mine.example.test/v1", apiKey: KEY_SAVED });
    const config = loadConfig({ ADMIN_SOCKET: join(r.dir, "missing.sock"), CADDYFILE_PATH: join(r.dir, "Caddyfile"), DATA_DIR: join(r.dir, "data"), LOG_DIR: r.dir, WEB_ROOT: r.dir, AUTH_USER: "owner", AUTH_PASSWORD: "x" });
    const again = await createApp(config, []);
    const login = await again.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "owner", password: "x" }) });
    const res = await again.request("/api/settings/ai", { headers: { Cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] } });
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body.baseUrl.value, "https://mine.example.test/v1");
    assert.equal(body.apiKey.source, "saved");
  } finally {
    await r.cleanup();
  }
});

/** A stand-in endpoint with a model list and a chat service that calls the tool only for the model "tool-model". */
async function fakeChat() {
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "tool-model" }, { id: "text-model" }] }));
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const model = JSON.parse(raw).model;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const delta = model === "tool-model" ? { tool_calls: [{ index: 0, id: "c", function: { name: "report_ready", arguments: "{}" } }] } : { content: "no" };
      res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await listen(server);
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => close(server) };
}

test("models come from the environment, are saved per task, marked changed, reset, and make a task ready", async () => {
  const r = await rig({ login: true, env: { baseUrl: "https://llm.example.test/v1", key: KEY_ENV, assistantModel: "model-a" } });
  try {
    const first = (await r.call("GET", "/api/settings/ai")).body;
    assert.deepEqual(first.assistantModel, { value: "model-a", default: "model-a", overridden: false });
    assert.deepEqual(first.reviewModel, { value: null, default: null, overridden: false });
    assert.deepEqual(first.ready, { assistant: true, review: false });

    const saved = await r.call("PUT", "/api/settings/ai", { reviewModel: "model-b", assistantModel: "model-c" });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.reviewModel, { value: "model-b", default: null, overridden: true });
    assert.equal(saved.body.assistantModel.value, "model-c");
    assert.deepEqual(saved.body.ready, { assistant: true, review: true });

    const reset = await r.call("PUT", "/api/settings/ai", { assistantModel: null, reviewModel: null });
    assert.equal(reset.body.assistantModel.value, "model-a");
    assert.deepEqual(reset.body.ready, { assistant: true, review: false });
    assert.equal((await r.call("PUT", "/api/settings/ai", { reviewModel: "two words" })).status, 400);
  } finally {
    await r.cleanup();
  }
});

test("choosing a model needs a login", async () => {
  const r = await rig({ login: false });
  try {
    assert.equal((await r.call("PUT", "/api/settings/ai", { assistantModel: "model-a" })).status, 403);
  } finally {
    await r.cleanup();
  }
});

test("the model list is offered, and its absence is a 502 so the interface falls back to typing", async () => {
  const chat = await fakeChat();
  const r = await rig({ login: true });
  try {
    await r.call("PUT", "/api/settings/ai", { baseUrl: chat.url, apiKey: KEY_SAVED });
    const listed = await r.call("GET", "/api/settings/ai/models");
    assert.deepEqual(listed.body, { ok: true, models: ["text-model", "tool-model"] });
    await chat.close();
    const gone = await r.call("GET", "/api/settings/ai/models");
    assert.equal(gone.status, 502);
    assert.equal(gone.body.ok, false);
    assert.equal((await r.call("GET", "/api/settings/ai/models", undefined, false)).status, 401);
  } finally {
    await r.cleanup();
  }
});

test("the tool test runs on the model chosen for the task and reports whether it called the tool", async () => {
  const chat = await fakeChat();
  const r = await rig({ login: true });
  try {
    await r.call("PUT", "/api/settings/ai", { baseUrl: chat.url, assistantModel: "tool-model", reviewModel: "text-model" });
    const good = await r.call("POST", "/api/settings/ai/test-model", { task: "assistant" });
    assert.equal(good.status, 200);
    assert.deepEqual(good.body, { ok: true });
    const bad = await r.call("POST", "/api/settings/ai/test-model", { task: "review" });
    assert.equal(bad.status, 502);
    assert.equal(bad.body.reason, "no_tool_call");
    assert.equal((await r.call("POST", "/api/settings/ai/test-model", { task: "other" })).status, 400);
    await r.call("PUT", "/api/settings/ai", { reviewModel: null });
    assert.equal((await r.call("POST", "/api/settings/ai/test-model", { task: "review" })).status, 400);
    assert.equal((await r.call("POST", "/api/settings/ai/test-model", { task: "assistant" }, false)).status, 401);
  } finally {
    await r.cleanup();
    await chat.close();
  }
});
