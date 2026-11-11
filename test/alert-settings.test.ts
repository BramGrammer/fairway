import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_POLICY } from "../src/server/alert-policy.js";
import { AlertSettings, type AlertEnv } from "../src/server/alert-settings.js";

const ENV: AlertEnv = { ntfyUrls: ["https://ntfy.example.test/env-topic"], ntfyToken: "tk_env", publicUrl: "https://fairway.example.test" };
const NONE: AlertEnv = { ntfyUrls: [], ntfyToken: null, publicUrl: null };

const fileIn = async () => join(await mkdtemp(join(tmpdir(), "alert-settings-")), "alert-settings.json");

test("without anything saved the environment and the defaults are in force", () => {
  const s = new AlertSettings(ENV);
  const effective = s.effective();
  assert.equal(effective.topics.length, 1);
  assert.equal(effective.topics[0].source, "env");
  assert.equal(effective.topics[0].token, "tk_env");
  assert.equal(effective.topics[0].enabled, true);
  assert.equal(effective.publicUrl, "https://fairway.example.test");
  assert.deepEqual(effective.policy, DEFAULT_POLICY);
  assert.notEqual(s.sender(), null);
  assert.equal(new AlertSettings(NONE).sender(), null);
});

test("the view never contains an address or a token; host names only when asked", async () => {
  const s = new AlertSettings(ENV);
  await s.addTopic({ name: "Phone", url: "https://other.example.test/secret-path", token: "tk_saved" });
  for (const showHosts of [false, true]) {
    const text = JSON.stringify(s.view(showHosts));
    assert.doesNotMatch(text, /env-topic|secret-path|tk_env|tk_saved/);
  }
  assert.equal(s.view(false).topics.some((t) => "host" in t), false);
  assert.deepEqual(s.view(true).topics.map((t) => [t.name, t.host, t.hasToken]), [
    ["ntfy topic", "ntfy.example.test", true],
    ["Phone", "other.example.test", true],
  ]);
});

test("topics can be added, changed and removed; the environment's can only be switched", async () => {
  const s = new AlertSettings(ENV);
  const added = await s.addTopic({ name: " Phone ", url: "https://a.example.test/t" });
  assert.ok(added.ok);
  const id = (added as { id: string }).id;
  assert.equal(s.effective().topics.at(-1)?.name, "Phone");
  assert.equal((await s.updateTopic(id, { token: "tk", enabled: false, name: "Tablet" })).ok, true);
  const saved = s.effective().topics.find((t) => t.id === id)!;
  assert.deepEqual([saved.name, saved.token, saved.enabled], ["Tablet", "tk", false]);
  assert.equal((await s.updateTopic(id, { token: null })).ok, true);
  assert.equal(s.effective().topics.find((t) => t.id === id)!.token, null);

  const envId = s.effective().topics[0].id;
  assert.equal((await s.updateTopic(envId, { enabled: false })).ok, true);
  assert.equal(s.effective().topics[0].enabled, false);
  assert.equal((await s.updateTopic(envId, { url: "https://x.example.test" })).ok, false);
  assert.equal((await s.removeTopic(envId)).ok, false);
  assert.equal((await s.updateTopic(envId, { enabled: true })).ok, true);
  assert.equal(s.effective().topics[0].enabled, true);

  assert.equal((await s.removeTopic(id)).ok, true);
  assert.equal(s.effective().topics.length, 1);
});

test("a topic that is switched off is not sent to, but can still be tested", async () => {
  const s = new AlertSettings(NONE);
  const { id } = (await s.addTopic({ name: "Phone", url: "https://a.example.test/t" })) as { id: string };
  await s.updateTopic(id, { enabled: false });
  assert.equal(s.sender(), null);
  assert.notEqual(s.senderFor(id), null);
  assert.equal(s.senderFor("nope"), null);
});

test("bad topics are refused with a reason", async () => {
  const s = new AlertSettings(NONE);
  for (const bad of [
    { name: "", url: "https://a.example.test" },
    { name: "x", url: "not a url" },
    { name: "x", url: "ftp://a.example.test" },
    { name: "x".repeat(61), url: "https://a.example.test" },
  ]) {
    const result = await s.addTopic(bad);
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /\w/);
  }
  assert.equal(s.effective().topics.length, 0);
  for (let i = 0; i < 10; i++) assert.equal((await s.addTopic({ name: `t${i}`, url: "https://a.example.test" })).ok, true);
  assert.equal((await s.addTopic({ name: "one more", url: "https://a.example.test" })).ok, false);
});

test("triggers and timing override the defaults and can be reset", async () => {
  const s = new AlertSettings(NONE);
  assert.equal((await s.patch({ triggers: { rollback: true, cert: false }, timing: { caddyHoldSec: 45 } })).ok, true);
  let policy = s.effective().policy;
  assert.equal(policy.triggers.rollback, true);
  assert.equal(policy.triggers.cert, false);
  assert.equal(policy.triggers.upstream, true);
  assert.equal(policy.caddyHoldSec, 45);
  assert.equal(policy.upstreamHoldSec, DEFAULT_POLICY.upstreamHoldSec);
  assert.deepEqual(s.view(false).triggers.cert, { value: false, overridden: true });
  assert.deepEqual(s.view(false).timing.caddyHoldSec, { value: 45, default: 15, overridden: true, min: 5, max: 600 });

  await s.patch({ triggers: { cert: null }, timing: { caddyHoldSec: null } });
  policy = s.effective().policy;
  assert.equal(policy.triggers.cert, true);
  assert.equal(policy.caddyHoldSec, 15);
  assert.equal(s.view(false).triggers.cert.overridden, false);
});

test("out of range or unknown values change nothing", async () => {
  const s = new AlertSettings(NONE);
  for (const bad of [
    { timing: { caddyHoldSec: 1 } },
    { timing: { caddyHoldSec: 15.5 } },
    { timing: { flapChanges: 1000 } },
    { timing: { nonsense: 5 } },
    { triggers: { cert: "yes" } },
    { triggers: { nonsense: true } },
    { publicUrl: "javascript:alert(1)" },
  ]) {
    const result = await s.patch(bad as never);
    assert.equal(result.ok, false, JSON.stringify(bad));
  }
  assert.deepEqual(s.effective().policy, DEFAULT_POLICY);
});

test("the public address: override, no link, or back to the environment's", async () => {
  const s = new AlertSettings(ENV);
  await s.patch({ publicUrl: "https://mine.example.test" });
  assert.equal(s.effective().publicUrl, "https://mine.example.test");
  await s.patch({ publicUrl: "" });
  assert.equal(s.effective().publicUrl, null);
  assert.equal(s.view(false).publicUrl.overridden, true);
  await s.patch({ publicUrl: null });
  assert.equal(s.effective().publicUrl, "https://fairway.example.test");
  assert.equal(s.view(false).publicUrl.overridden, false);
});

test("changes are announced to listeners and survive a restart; the file is private", async () => {
  const file = await fileIn();
  const a = new AlertSettings(ENV, file);
  let calls = 0;
  a.onChange(() => calls++);
  await a.addTopic({ name: "Phone", url: "https://a.example.test/t", token: "tk" });
  await a.patch({ triggers: { rollback: true }, timing: { upstreamHoldSec: 120 }, publicUrl: "https://mine.example.test" });
  await a.updateTopic(a.effective().topics[0].id, { enabled: false });
  assert.equal(calls, 3);

  const b = new AlertSettings(ENV, file);
  await b.load();
  assert.deepEqual(b.effective(), a.effective());
  assert.equal(((await stat(file)).mode & 0o077), 0);
});

test("a refused change is not announced, and a corrupt file is ignored", async () => {
  const s = new AlertSettings(NONE);
  let calls = 0;
  s.onChange(() => calls++);
  await s.patch({ timing: { caddyHoldSec: 1 } });
  assert.equal(calls, 0);

  const file = await fileIn();
  await writeFile(file, "{ nope");
  const broken = new AlertSettings(ENV, file);
  await broken.load();
  assert.deepEqual(broken.effective().policy, DEFAULT_POLICY);
  await writeFile(file, JSON.stringify({ version: 1, topics: [{ id: "t_1", name: "ok", url: "https://a.example.test", enabled: true }, { id: "t_2", name: "bad", url: "nope", enabled: true }], timing: { caddyHoldSec: 99999 }, triggers: { cert: "x" } }));
  await broken.load();
  assert.deepEqual(broken.effective().topics.map((t) => t.id).slice(1), ["t_1"]);
  assert.deepEqual(broken.effective().policy, DEFAULT_POLICY);
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 1);
});

test("a failing write is reported and leaves the settings as they were", async () => {
  const s = new AlertSettings(NONE, "/dev/null/impossible/alert-settings.json");
  const result = await s.patch({ triggers: { cert: false } });
  assert.equal(result.ok, false);
  assert.equal(s.effective().policy.triggers.cert, true);
});

// ---- per host ----

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
const routes = (map: Record<string, string[]> = {}) => () => ({ upstreamHosts: new Map(Object.entries(map)) });

test("a host sends no Alerts until it is switched on", async () => {
  const s = new AlertSettings(NONE);
  const scope = s.scope(routes());
  assert.equal(scope("cert:a.test", T0).send, false);
  assert.equal(scope("host:a.test", T0).send, false);
  assert.equal(scope("caddy", T0).send, true); // Caddy is not about a host
  assert.equal((await s.patch({ hosts: { "a.test": { enabled: true } } })).ok, true);
  assert.equal(scope("cert:a.test", T0).send, true);
  assert.equal(scope("host:a.test", T0).send, true);
  assert.equal(scope("cert:b.test", T0).send, false);
});

test("each kind can be switched off for a host", async () => {
  const s = new AlertSettings(NONE);
  const scope = s.scope(routes({ "upstream:app:80": ["a.test"] }));
  await s.patch({ hosts: { "a.test": { enabled: true, kinds: { cert: false } } } });
  assert.equal(scope("cert:a.test", T0).send, false);
  assert.equal(scope("host:a.test", T0).send, true);
  assert.equal(scope("upstream:app:80", T0).send, true);
  await s.patch({ hosts: { "a.test": { kinds: { upstream: false } } } });
  assert.equal(scope("upstream:app:80", T0).send, false);
  assert.deepEqual(s.view(false).hosts["a.test"], { enabled: true, kinds: { cert: false, host: true, upstream: false }, snoozedUntil: null });
});

test("a shared upstream alerts while any of its hosts is on, and names those hosts", async () => {
  const s = new AlertSettings(NONE);
  const scope = s.scope(routes({ "upstream:app:80": ["a.test", "b.test", "c.test"], "upstream:only-c:80": ["c.test"] }));
  assert.equal(scope("upstream:app:80", T0).send, false);
  await s.patch({ hosts: { "a.test": { enabled: true }, "c.test": { enabled: true } } });
  assert.deepEqual(scope("upstream:app:80", T0), { send: true, hosts: ["a.test", "c.test"] });
  await s.patch({ hosts: { "a.test": { enabled: false }, "c.test": { enabled: false } } });
  assert.equal(scope("upstream:app:80", T0).send, false);
  assert.equal(scope("upstream:unknown:80", T0).send, false);
});

test("a snooze holds a host's Alerts back until it ends, and can be ended early", async () => {
  let now = T0;
  const s = new AlertSettings(NONE, undefined, () => now);
  const scope = s.scope(routes());
  await s.patch({ hosts: { "a.test": { enabled: true, snoozeMinutes: 60 } } });
  assert.equal(s.view(false).hosts["a.test"].snoozedUntil, T0 + 60 * MIN);
  assert.equal(scope("cert:a.test", T0 + 59 * MIN).send, false);
  assert.equal(scope("cert:a.test", T0 + 61 * MIN).send, true);
  await s.patch({ hosts: { "a.test": { snoozeMinutes: 120 } } });
  assert.equal(scope("cert:a.test", now + 10 * MIN).send, false);
  await s.patch({ hosts: { "a.test": { snoozeMinutes: null } } });
  assert.equal(scope("cert:a.test", now + 10 * MIN).send, true);
  assert.equal((await s.patch({ hosts: { "a.test": { snoozeMinutes: 0 } } })).ok, false);
  assert.equal((await s.patch({ hosts: { "a.test": { snoozeMinutes: 100000 } } })).ok, false);
});

test("a host that is back to its quiet state is forgotten; null forgets it too", async () => {
  const s = new AlertSettings(NONE);
  await s.patch({ hosts: { "a.test": { enabled: true }, "b.test": { enabled: true } } });
  await s.patch({ hosts: { "a.test": { enabled: false } } });
  assert.deepEqual(Object.keys(s.view(false).hosts), ["b.test"]);
  await s.patch({ hosts: { "b.test": null } });
  assert.deepEqual(s.view(false).hosts, {});
});

test("hosts that left the config stay set, and come back set", async () => {
  const file = await fileIn();
  const a = new AlertSettings(NONE, file);
  await a.patch({ hosts: { "gone.test": { enabled: true, kinds: { host: false } } } });
  const b = new AlertSettings(NONE, file);
  await b.load();
  assert.deepEqual(b.view(false).hosts["gone.test"], { enabled: true, kinds: { cert: true, host: false, upstream: true }, snoozedUntil: null });
});

test("bad host settings are refused and change nothing", async () => {
  const s = new AlertSettings(NONE);
  for (const bad of [
    '{"":{"enabled":true}}',
    '{"__proto__":{"enabled":true}}',
    '{"a.test":{"enabled":"yes"}}',
    '{"a.test":{"kinds":{"nonsense":true}}}',
    '{"a.test":{"kinds":{"cert":"no"}}}',
  ]) {
    const result = await s.patch({ hosts: JSON.parse(bad) as never });
    assert.equal(result.ok, false, bad);
  }
  assert.deepEqual(s.view(false).hosts, {});
});
