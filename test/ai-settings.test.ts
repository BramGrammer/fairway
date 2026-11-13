import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_AI_BASE_URL } from "../src/server/ai-endpoint.js";
import { AiSettings } from "../src/server/ai-settings.js";

const ENV = { baseUrl: "https://llm.example.test/v1", apiKey: "sk-env-made-up" };
const NONE = { baseUrl: null, apiKey: null };
const fileIn = async () => join(await mkdtemp(join(tmpdir(), "ce-ai-")), "ai-settings.json");

test("without an environment the address is OpenRouter's and there is no key", () => {
  const s = new AiSettings(NONE);
  assert.deepEqual(s.effective(), { baseUrl: DEFAULT_AI_BASE_URL, apiKey: null });
  assert.deepEqual(s.view(), {
    baseUrl: { value: DEFAULT_AI_BASE_URL, default: DEFAULT_AI_BASE_URL, overridden: false },
    apiKey: { set: false, source: null, overridden: false },
    assistantModel: { value: null, default: null, overridden: false },
    reviewModel: { value: null, default: null, overridden: false },
    reviewInterval: { value: "24h", default: "24h", overridden: false },
    assistantPrice: null,
    ready: { assistant: false, review: false },
  });
});

test("the environment gives the values, what is saved wins, reset goes back", async () => {
  const s = new AiSettings(ENV);
  assert.deepEqual(s.effective(), { baseUrl: "https://llm.example.test/v1", apiKey: "sk-env-made-up" });
  assert.equal(s.view().apiKey.source, "env");

  assert.deepEqual(await s.patch({ baseUrl: "http://localhost:11434/v1/", apiKey: "sk-saved-made-up" }), { ok: true });
  assert.deepEqual(s.effective(), { baseUrl: "http://localhost:11434/v1", apiKey: "sk-saved-made-up" });
  assert.equal(s.view().baseUrl.overridden, true);
  assert.deepEqual(s.view().apiKey, { set: true, source: "saved", overridden: true });

  await s.patch({ baseUrl: null });
  assert.equal(s.effective().baseUrl, "https://llm.example.test/v1");
  assert.equal(s.effective().apiKey, "sk-saved-made-up");
  await s.patch({ apiKey: null });
  assert.deepEqual(s.effective(), { baseUrl: "https://llm.example.test/v1", apiKey: "sk-env-made-up" });
  assert.equal(s.view().apiKey.overridden, false);
});

test("the view never contains a key", async () => {
  const s = new AiSettings(ENV);
  await s.patch({ apiKey: "sk-saved-made-up" });
  assert.doesNotMatch(JSON.stringify(s.view()), /sk-saved-made-up|sk-env-made-up/);
});

test("a bad address or key is refused and changes nothing", async () => {
  const s = new AiSettings(ENV);
  for (const bad of [{ baseUrl: "" }, { baseUrl: "nope" }, { baseUrl: "ftp://a.example.test" }, { baseUrl: "https://user:pw@a.example.test" }, { baseUrl: "https://a.example.test/?k=1" }, { baseUrl: 5 }, { apiKey: "" }, { apiKey: "two words" }, { apiKey: 5 }, { apiKey: "x".repeat(600) }]) {
    assert.equal((await s.patch(bad as never)).ok, false, JSON.stringify(bad));
  }
  assert.equal(s.view().baseUrl.overridden, false);
  assert.equal(s.view().apiKey.overridden, false);
});

test("changes are announced, survive a restart, and the file is private", async () => {
  const file = await fileIn();
  const a = new AiSettings(ENV, file);
  let calls = 0;
  a.onChange(() => calls++);
  await a.patch({ baseUrl: "https://mine.example.test/api/v1", apiKey: "sk-saved-made-up" });
  await a.patch({ baseUrl: "bad" });
  assert.equal(calls, 1);
  assert.equal((await stat(file)).mode & 0o077, 0);

  const b = new AiSettings(ENV, file);
  await b.load();
  assert.deepEqual(b.effective(), a.effective());
});

test("a corrupt or foreign file is ignored", async () => {
  const file = await fileIn();
  const s = new AiSettings(ENV, file);
  await writeFile(file, "{ nope");
  await s.load();
  assert.equal(s.view().baseUrl.overridden, false);
  await writeFile(file, JSON.stringify({ version: 1, baseUrl: "nope", apiKey: 7 }));
  await s.load();
  assert.deepEqual(s.view().apiKey, { set: true, source: "env", overridden: false });
  assert.equal(await readFile(file, "utf8").then(Boolean), true);
});

test("each task's model comes from the environment, a saved choice wins, reset goes back", async () => {
  const s = new AiSettings({ ...ENV, assistantModel: "model-a", reviewModel: null });
  assert.deepEqual(s.view().assistantModel, { value: "model-a", default: "model-a", overridden: false });
  assert.deepEqual(s.view().ready, { assistant: true, review: false });

  assert.deepEqual(await s.patch({ assistantModel: " vendor/model-b:free ", reviewModel: "model-c" }), { ok: true });
  assert.deepEqual(s.view().assistantModel, { value: "vendor/model-b:free", default: "model-a", overridden: true });
  assert.deepEqual(s.view().ready, { assistant: true, review: true });

  await s.patch({ assistantModel: null, reviewModel: null });
  assert.deepEqual(s.view().assistantModel, { value: "model-a", default: "model-a", overridden: false });
  assert.equal(s.model("review"), null);
});

test("a task is ready without a key, since local servers need none", () => {
  const s = new AiSettings({ baseUrl: "http://localhost:11434/v1", apiKey: null, assistantModel: "model-a" });
  assert.equal(s.ready().assistant, true);
});

test("a bad model name is refused and changes nothing; models survive a restart", async () => {
  const file = await fileIn();
  const s = new AiSettings(ENV, file);
  for (const bad of ["", "two words", 5, "x".repeat(300)]) assert.equal((await s.patch({ assistantModel: bad as never })).ok, false, String(bad));
  assert.equal(s.model("assistant"), null);
  await s.patch({ assistantModel: "model-a", reviewModel: "model-b" });
  const again = new AiSettings(ENV, file);
  await again.load();
  assert.equal(again.model("assistant"), "model-a");
  assert.equal(again.model("review"), "model-b");
});

test("the Review interval defaults to 24 hours, follows the environment, and an override can be reset", async () => {
  const file = await fileIn();
  const s = new AiSettings({ ...NONE, reviewInterval: "weekly" }, file);
  assert.equal(s.reviewInterval(), "weekly");
  assert.deepEqual(s.view().reviewInterval, { value: "weekly", default: "weekly", overridden: false });
  assert.deepEqual(await s.patch({ reviewInterval: "6h" }), { ok: true });
  assert.deepEqual(s.view().reviewInterval, { value: "6h", default: "weekly", overridden: true });
  const again = new AiSettings({ ...NONE, reviewInterval: "weekly" }, file);
  await again.load();
  assert.equal(again.reviewInterval(), "6h");
  assert.equal((await s.patch({ reviewInterval: "hourly" })).ok, false);
  assert.equal(s.reviewInterval(), "6h");
  await s.patch({ reviewInterval: null });
  assert.equal(s.reviewInterval(), "weekly");
  assert.equal(new AiSettings({ ...NONE, reviewInterval: "nonsense" }).reviewInterval(), "24h");
  assert.equal(new AiSettings({ ...NONE, reviewInterval: "OFF" }).reviewInterval(), "off");
});

test("the Assistant's prices are kept as two amounts, refused when unusable, and reset by null", async () => {
  const s = new AiSettings(NONE);
  assert.equal(s.view().assistantPrice, null);
  assert.deepEqual(await s.patch({ assistantPrice: { input: 3, output: 15 } }), { ok: true });
  assert.deepEqual(s.view().assistantPrice, { input: 3, output: 15 });
  for (const bad of [{ input: -1, output: 1 }, { input: 1 }, { input: "1", output: 2 }, { input: Infinity, output: 1 }, { input: 1, output: 1e9 }] as unknown[]) {
    const result = await s.patch({ assistantPrice: bad as { input: number; output: number } });
    assert.equal(result.ok, false);
  }
  assert.deepEqual(s.view().assistantPrice, { input: 3, output: 15 });
  assert.deepEqual(await s.patch({ assistantPrice: null }), { ok: true });
  assert.equal(s.view().assistantPrice, null);
});
