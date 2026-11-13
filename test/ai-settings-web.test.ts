import assert from "node:assert/strict"
import { test } from "node:test"
import { apiKeyBody, baseUrlBody, describeBaseUrl, describeKey, filterModels, modelBody } from "../web/src/lib/ai-settings.js"

test("the address is trimmed and an empty one is refused", () => {
  assert.deepEqual(baseUrlBody("  https://a.example.test/v1 "), { ok: true, body: { baseUrl: "https://a.example.test/v1" } })
  assert.equal(baseUrlBody("  ").ok, false)
})

test("a new key is trimmed and an empty one is refused", () => {
  assert.deepEqual(apiKeyBody(" sk-made-up "), { ok: true, body: { apiKey: "sk-made-up" } })
  assert.equal(apiKeyBody("").ok, false)
})

test("the hints say where the values come from without showing a key", () => {
  assert.equal(describeKey({ set: false, source: null, overridden: false }), "No key is set.")
  assert.match(describeKey({ set: true, source: "env", overridden: false }), /environment/)
  assert.match(describeKey({ set: true, source: "saved", overridden: true }), /saved here/)
  assert.match(describeBaseUrl({ value: "https://a.example.test", default: "https://openrouter.ai/api/v1", overridden: true }), /Default https:\/\/openrouter/)
})

test("a model is trimmed, saved under its task's field, and an empty or spaced one is refused", () => {
  assert.deepEqual(modelBody("assistant", " model-a "), { ok: true, body: { assistantModel: "model-a" } })
  assert.deepEqual(modelBody("review", "model-b"), { ok: true, body: { reviewModel: "model-b" } })
  assert.equal(modelBody("review", " ").ok, false)
  assert.equal(modelBody("review", "two words").ok, false)
})

test("the model search ignores case and shows everything when empty", () => {
  const models = ["vendor/Alpha-1", "vendor/beta-2", "other/alpha-3"]
  assert.deepEqual(filterModels(models, "ALPHA"), ["vendor/Alpha-1", "other/alpha-3"])
  assert.deepEqual(filterModels(models, " "), models)
  assert.deepEqual(filterModels(models, "zzz"), [])
})
