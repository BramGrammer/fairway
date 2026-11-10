import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NtfySender, ntfyLook, parseNtfyUrls, type AlertPayload, type AlertSender } from "../src/server/alerts.js";
import { EventTracker, FLAP_STABLE_MS, MAX_EVENTS, RETENTION_MS } from "../src/server/events.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1);

function fakeSender(fail = false) {
  const sent: AlertPayload[] = [];
  const sender: AlertSender = {
    async send(payload) {
      if (fail) throw new Error("nope");
      sent.push(payload);
    },
  };
  return { sent, sender };
}

const tmpFile = async () => join(await mkdtemp(join(tmpdir(), "events-")), "events.json");

test("a Certificate that turns amber is recorded and alerted at once, and recovery is alerted too", async () => {
  const { sent, sender } = fakeSender();
  const t = new EventTracker({ sender });
  t.observe("cert:a.test", "ok", undefined, T0);
  t.observe("cert:a.test", "warning", "18 days left", T0 + MIN);
  t.observe("cert:a.test", "ok", undefined, T0 + 2 * MIN);
  await t.flush();
  assert.deepEqual(
    t.list({ subject: "cert:a.test" }).map((e) => [e.state, e.previous]),
    [["ok", "warning"], ["warning", "ok"], ["ok", null]],
  );
  assert.equal(sent.length, 2); // the first sighting of a healthy Subject is not news
  assert.equal(sent[0].state, "warning");
  assert.match(sent[0].message, /amber.*18 days left/);
  assert.equal(sent[1].state, "ok");
  assert.equal(sent[1].previous, "warning");
});

test("a brief upstream failure does not count; a held one does, once", async () => {
  const { sent, sender } = fakeSender();
  const t = new EventTracker({ sender });
  t.observe("upstream:app:80", "ok", undefined, T0);
  t.observe("upstream:app:80", "down", undefined, T0 + 5_000);
  t.observe("upstream:app:80", "ok", undefined, T0 + 10_000); // blip: back before the hold ends
  assert.equal(t.stateOf("upstream:app:80"), "ok");
  t.observe("upstream:app:80", "down", undefined, T0 + 20_000);
  t.observe("upstream:app:80", "down", undefined, T0 + 50_000);
  assert.equal(t.stateOf("upstream:app:80"), "ok"); // 30 s is not enough for an upstream
  t.observe("upstream:app:80", "down", undefined, T0 + 80_000);
  t.observe("upstream:app:80", "down", undefined, T0 + 90_000); // still down: no second Alert
  await t.flush();
  assert.equal(t.stateOf("upstream:app:80"), "down");
  assert.equal(sent.length, 1);
  const down = t.list({ subject: "upstream:app:80" })[0];
  assert.equal(down.at, T0 + 20_000); // the History shows when it began, not when it was confirmed
});

test("Caddy needs about 15 seconds of silence", () => {
  const t = new EventTracker();
  t.observe("caddy", "ok", undefined, T0);
  t.observe("caddy", "down", undefined, T0 + 5_000);
  t.observe("caddy", "down", undefined, T0 + 10_000);
  assert.equal(t.stateOf("caddy"), "ok");
  t.observe("caddy", "down", undefined, T0 + 20_000);
  assert.equal(t.stateOf("caddy"), "down");
});

test("after a restart an unchanged State does not alert again", async () => {
  const file = await tmpFile();
  const first = fakeSender();
  const a = new EventTracker({ file, sender: first.sender });
  a.observe("cert:a.test", "down", "expired", T0);
  await a.flush();
  await a.save();
  assert.equal(first.sent.length, 1);

  const second = fakeSender();
  const b = new EventTracker({ file, sender: second.sender, now: () => T0 + 10 * MIN });
  await b.load();
  b.beat(T0 + 10 * MIN);
  b.observe("cert:a.test", "down", "expired", T0 + 10 * MIN);
  await b.flush();
  assert.equal(second.sent.length, 0);
  assert.equal(b.stateOf("cert:a.test"), "down");

  b.observe("cert:a.test", "ok", undefined, T0 + 11 * MIN); // a change after the restart still alerts
  await b.flush();
  assert.equal(second.sent.length, 1);
});

test("a silence longer than two minutes is a Gap, which never alerts and shows as unknown", async () => {
  const { sent, sender } = fakeSender();
  const t = new EventTracker({ sender });
  t.beat(T0);
  t.observe("caddy", "ok", undefined, T0);
  t.beat(T0 + 20 * MIN);
  t.observe("caddy", "ok", undefined, T0 + 20 * MIN);
  await t.flush();
  assert.equal(sent.length, 0);
  const gap = t.list().find((e) => e.kind === "gap");
  assert.equal(gap?.at, T0);
  assert.equal(gap?.until, T0 + 20 * MIN);
  assert.deepEqual(t.timeline(["caddy"], T0, T0 + 30 * MIN), [
    { from: T0, to: T0 + 20 * MIN, state: "unknown" },
    { from: T0 + 20 * MIN, to: T0 + 30 * MIN, state: "ok" },
  ]);
});

test("regular beats make no Gap", () => {
  const t = new EventTracker();
  for (let i = 0; i < 10; i++) t.beat(T0 + i * 5_000);
  assert.equal(t.list().length, 0);
});

test("the timeline shows the worst State among a host's Subjects", () => {
  const t = new EventTracker();
  t.observe("cert:a.test", "ok", undefined, T0);
  t.observe("upstream:app:80", "ok", undefined, T0);
  t.observe("upstream:app:80", "down", undefined, T0 + 10 * MIN);
  t.observe("upstream:app:80", "down", undefined, T0 + 11 * MIN);
  t.observe("upstream:app:80", "ok", undefined, T0 + 20 * MIN);
  t.observe("upstream:app:80", "ok", undefined, T0 + 21 * MIN);
  assert.deepEqual(t.timeline(["cert:a.test", "upstream:app:80"], T0 - MIN, T0 + 30 * MIN), [
    { from: T0 - MIN, to: T0, state: "unknown" },
    { from: T0, to: T0 + 10 * MIN, state: "ok" },
    { from: T0 + 10 * MIN, to: T0 + 20 * MIN, state: "down" },
    { from: T0 + 20 * MIN, to: T0 + 30 * MIN, state: "ok" },
  ]);
});

test("a Subject that leaves the config is closed without an Alert", async () => {
  const { sent, sender } = fakeSender();
  const t = new EventTracker({ sender });
  t.observe("upstream:old:80", "ok", undefined, T0);
  t.observe("upstream:new:80", "ok", undefined, T0);
  t.sync("upstream", ["upstream:new:80"], T0 + MIN);
  await t.flush();
  assert.equal(t.stateOf("upstream:old:80"), null);
  assert.equal(t.stateOf("upstream:new:80"), "ok");
  assert.equal(t.list()[0].kind, "removed");
  assert.equal(sent.length, 0);
  assert.deepEqual(t.timeline(["upstream:old:80"], T0, T0 + 2 * MIN), [
    { from: T0, to: T0 + MIN, state: "ok" },
    { from: T0 + MIN, to: T0 + 2 * MIN, state: "unknown" },
  ]);
});

test("sync leaves Subjects of other kinds alone", () => {
  const t = new EventTracker();
  t.observe("cert:a.test", "ok", undefined, T0);
  t.sync("upstream", [], T0 + MIN);
  assert.equal(t.stateOf("cert:a.test"), "ok");
});

test("a flapping Subject sends one flapping Alert, is held, then announced once when stable", async () => {
  const { sent, sender } = fakeSender();
  const t = new EventTracker({ sender });
  t.observe("cert:a.test", "ok", undefined, T0);
  for (let i = 1; i <= 8; i++) t.observe("cert:a.test", i % 2 ? "down" : "ok", undefined, T0 + i * MIN);
  await t.flush();
  // changes 1-4 alert, the fifth is the flapping Alert, the rest are held
  assert.deepEqual(sent.map((p) => p.event), ["state", "state", "state", "state", "flapping"]);

  const settledAt = T0 + 8 * MIN + FLAP_STABLE_MS;
  t.observe("cert:a.test", "ok", undefined, settledAt - MIN);
  assert.equal(sent.length, 5);
  t.observe("cert:a.test", "ok", undefined, settledAt);
  await t.flush();
  assert.equal(sent.length, 6);
  assert.equal(sent[5].event, "flapping");
  assert.equal(sent[5].state, "ok");

  t.observe("cert:a.test", "down", "expired", settledAt + MIN); // alerts work again
  await t.flush();
  assert.equal(sent.length, 7);
});

test("a failed deploy and an outside edit alert; a rollback is history only", async () => {
  const { sent, sender } = fakeSender();
  const t = new EventTracker({ sender });
  t.record("deploy_failed", "Caddy refused the reload", T0);
  t.record("external_edit", "The Caddyfile changed outside Fairway", T0 + MIN);
  t.record("rollback", "Rolled back to revision 4", T0 + 2 * MIN);
  await t.flush();
  assert.deepEqual(sent.map((p) => p.event), ["deploy_failed", "external_edit"]);
  assert.equal(t.list().length, 3);
  assert.equal(t.list()[0].delivery, undefined);
  assert.equal(t.list()[2].delivery, "sent");
});

test("a failed delivery is marked on the event", async () => {
  const { sender } = fakeSender(true);
  const t = new EventTracker({ sender });
  t.record("deploy_failed", "x", T0);
  assert.equal(t.list()[0].delivery, "pending");
  await t.flush();
  assert.equal(t.list()[0].delivery, "failed");
});

test("without ntfy nothing is marked for delivery", () => {
  const t = new EventTracker();
  t.record("deploy_failed", "x", T0);
  assert.equal(t.list()[0].delivery, undefined);
  assert.equal(t.alertsEnabled, false);
});

test("the Alert carries a link only when the public address is set, and test alerts are marked", async () => {
  const { sent, sender } = fakeSender();
  const t = new EventTracker({ sender, publicUrl: "https://fairway.example.test" });
  t.record("deploy_failed", "x", T0);
  assert.deepEqual(await t.sendTest(T0), { ok: true });
  await t.flush();
  assert.equal(sent[0].link, "https://fairway.example.test");
  assert.equal(sent[1].test, true);
  assert.equal(t.list().length, 1); // the test is not recorded
  assert.equal((await new EventTracker().sendTest()).ok, false);
});

test("history older than 30 days and beyond the cap is dropped", () => {
  let now = T0;
  const t = new EventTracker({ now: () => now });
  t.record("rollback", "old", now);
  now += RETENTION_MS + MIN;
  t.record("rollback", "new", now);
  assert.deepEqual(t.list().map((e) => e.message), ["new"]);
  for (let i = 0; i < MAX_EVENTS + 50; i++) t.record("rollback", `r${i}`, now);
  assert.equal(t.list({ limit: 5000 }).length, MAX_EVENTS);
});

test("history survives a restart; a corrupt file is ignored", async () => {
  const file = await tmpFile();
  const a = new EventTracker({ file, now: () => T0 });
  a.record("rollback", "kept", T0);
  await a.save();
  const b = new EventTracker({ file, now: () => T0 });
  await b.load();
  assert.deepEqual(b.list().map((e) => e.message), ["kept"]);
  b.record("rollback", "next", T0);
  assert.equal(b.list()[0].id, 2);

  await writeFile(file, "{ not json");
  const c = new EventTracker({ file });
  await c.load();
  assert.equal(c.list().length, 0);
  await c.save();
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 1);
});

test("an Alert that was still pending when Fairway stopped shows as failed after a restart", async () => {
  const file = await tmpFile();
  const never: AlertSender = { send: () => new Promise(() => {}) };
  const a = new EventTracker({ file, sender: never, now: () => T0 });
  a.record("deploy_failed", "x", T0);
  await a.save();
  const b = new EventTracker({ file, now: () => T0 });
  await b.load();
  assert.equal(b.list()[0].delivery, "failed");
});

// ---- the ntfy sender ----

const payload: AlertPayload = { event: "state", subject: "caddy", state: "down", previous: "ok", since: new Date(T0).toISOString(), message: "Caddy is not answering", link: "https://fairway.example.test" };
const TOPIC = "https://ntfy.example.test/secret-topic";

test("ntfy gets the message as plain text with a title, a priority, a tag and a link", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const sender = new NtfySender([TOPIC], {
    fetchFn: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response("ok");
    },
  });
  await sender.send(payload);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TOPIC);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, "Caddy is not answering");
  assert.deepEqual(calls[0].init.headers, {
    "Content-Type": "text/plain; charset=utf-8",
    Title: "Fairway: problem",
    Priority: "high",
    Tags: "rotating_light",
    Click: "https://fairway.example.test",
  });
});

test("the token is sent as a bearer login, and only when set", async () => {
  const seen: unknown[] = [];
  const fetchFn: typeof fetch = async (_url, init) => {
    seen.push((init!.headers as Record<string, string>).Authorization);
    return new Response("ok");
  };
  await new NtfySender([TOPIC], { token: "tk_secret", fetchFn }).send(payload);
  await new NtfySender([TOPIC], { fetchFn }).send(payload);
  assert.deepEqual(seen, ["Bearer tk_secret", undefined]);
});

test("each kind of message looks right", () => {
  const look = (over: Partial<AlertPayload>) => ntfyLook({ ...payload, ...over });
  assert.deepEqual(look({ state: "warning" }), { title: "Fairway: warning", priority: "default", tags: "warning" });
  assert.equal(look({ state: "ok" }).title, "Fairway: recovered");
  assert.equal(look({ event: "deploy_failed", state: null }).priority, "high");
  assert.equal(look({ event: "external_edit", state: null }).title, "Fairway: Caddyfile edited");
  assert.equal(look({ test: true }).title, "Fairway: test");
});

test("every topic gets the message; one failing does not stop the others", async () => {
  const hit: string[] = [];
  const sender = new NtfySender(["https://a.example.test/t", "https://b.example.test/t"], {
    fetchFn: async (url) => {
      hit.push(String(url));
      return new Response("", { status: String(url).includes("a.") ? 500 : 200 });
    },
    sleep: async () => {},
    delays: [],
  });
  await assert.rejects(sender.send(payload), /500/);
  assert.deepEqual(hit.sort(), ["https://a.example.test/t", "https://b.example.test/t"]);
});

test("a failing ntfy is retried three times with growing pauses, then gives up without leaking the topic or token", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const sender = new NtfySender([TOPIC], {
    token: "tk_secret",
    fetchFn: async () => {
      calls++;
      throw new TypeError(`fetch failed ${TOPIC} tk_secret`);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await assert.rejects(sender.send(payload), (error: Error) => {
    assert.doesNotMatch(error.message, /secret-topic|tk_secret|ntfy\.example/);
    return true;
  });
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [10_000, 60_000, 300_000]);
});

test("an ntfy that recovers on a retry delivers once", async () => {
  let calls = 0;
  const sender = new NtfySender([TOPIC], {
    fetchFn: async () => new Response("", { status: ++calls < 3 ? 500 : 200 }),
    sleep: async () => {},
  });
  await sender.send(payload);
  assert.equal(calls, 3);
});

test("a test send does not retry", async () => {
  let calls = 0;
  const sender = new NtfySender([TOPIC], {
    fetchFn: async () => new Response("", { status: (++calls, 500) }),
    sleep: async () => {},
  });
  await assert.rejects(sender.send(payload, { retry: false }), /500/);
  assert.equal(calls, 1);
});

test("NTFY_URL may list several topics", () => {
  assert.deepEqual(parseNtfyUrls(" https://a.example.test/x , https://b.example.test/y ,"), ["https://a.example.test/x", "https://b.example.test/y"]);
  assert.deepEqual(parseNtfyUrls(undefined), []);
  assert.deepEqual(parseNtfyUrls(""), []);
});
