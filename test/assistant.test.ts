import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.js";
import { maskCaddyfile } from "../src/server/masking.js";
import { ASSISTANT_LIMITS, buildSystemPrompt, runTurn, startsNewParagraph, type TurnEvent, type TurnStep } from "../src/server/assistant.js";
import { loadConfig } from "../src/server/config.js";
import type { Finding } from "../src/server/findings.js";

const SECRET = "fake-token-value-123";
const CADDYFILE = `example.test {\n\theader_up Authorization ${SECRET}\n\treverse_proxy app:8080\n}\n`;

const listen = (server: Server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";

interface Seen {
  body: { model: string; max_tokens?: number; tools?: unknown; messages: Array<{ role: string; content: string }> };
}

/** A stand-in model endpoint: answers each chat call with the next script step and remembers what it was sent. */
async function fakeEndpoint(steps: Array<{ status?: number; chunks?: unknown[]; hang?: boolean }>) {
  const seen: Seen[] = [];
  let closedByClient = false;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seen.push({ body: JSON.parse(raw) });
      const step = steps[Math.min(seen.length - 1, steps.length - 1)]!;
      res.on("close", () => {
        if (!res.writableEnded) closedByClient = true;
      });
      res.writeHead(step.status ?? 200, { "Content-Type": step.status && step.status >= 400 ? "application/json" : "text/event-stream" });
      if (step.hang) return void res.write(sse([{ choices: [{ delta: { content: "start" } }] }]).replace("data: [DONE]\n\n", ""));
      res.end(step.status && step.status >= 400 ? "{}" : sse(step.chunks ?? []));
    });
  });
  await listen(server);
  return { seen, closedByClient: () => closedByClient, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => close(server) };
}

const answer = (text: string, extra: unknown[] = []) => [
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 120, completion_tokens: 15 } },
  ...extra,
];

/** The events of a turn, without the context overview and the steps, which have their own tests. */
async function collect(events: AsyncGenerator<TurnEvent>) {
  const out: TurnEvent[] = [];
  for await (const e of events) if (e.type !== "context" && e.type !== "step") out.push(e);
  return out;
}

const warning: Finding = { level: "warning", message: `Secret ${SECRET} written inline`, line: 2, origin: "rules" };

test("a turn sends the masked buffer and its Findings, and streams the answer with its usage", async () => {
  const endpoint = await fakeEndpoint([{ chunks: answer("It proxies ") }]);
  try {
    const request = { text: CADDYFILE, messages: [{ role: "user" as const, content: "What does this Site do?" }] };
    const events = await collect(runTurn({ endpoint: { baseUrl: endpoint.baseUrl, apiKey: null }, model: "model-a", validate: async () => [warning] }, request));
    assert.deepEqual(events, [{ type: "text", delta: "It proxies " }, { type: "usage", usage: { promptTokens: 120, completionTokens: 15 } }]);
    const sent = endpoint.seen[0]!.body;
    const system = sent.messages[0]!;
    assert.equal(system.role, "system");
    assert.ok(!JSON.stringify(sent).includes(SECRET), "the secret must not leave");
    assert.match(system.content, /header_up Authorization __FAIRWAY_SECRET_1__/);
    assert.match(system.content, /__FAIRWAY_SECRET_1__: header credential \(Authorization\)/);
    assert.match(system.content, /warning, line 2: Secret __FAIRWAY_SECRET_1__ written inline/);
    assert.match(system.content, /reverse_proxy app:8080/);
    assert.deepEqual(sent.messages.slice(1), [{ role: "user", content: "What does this Site do?" }]);
    assert.equal(sent.max_tokens, ASSISTANT_LIMITS.maxOutputTokens);
  } finally {
    await endpoint.close();
  }
});

test("a follow-up keeps the earlier turns as context and uses the buffer as it is now", async () => {
  const endpoint = await fakeEndpoint([{ chunks: answer("ok") }]);
  try {
    const edited = CADDYFILE + "other.test {\n\trespond hi\n}\n";
    await collect(
      runTurn(
        { endpoint: { baseUrl: endpoint.baseUrl, apiKey: null }, model: "model-a", validate: async () => [] },
        { text: edited, messages: [{ role: "user", content: "first" }, { role: "assistant", content: "the token is __FAIRWAY_SECRET_1__" }, { role: "user", content: "second" }] },
      ),
    );
    const sent = endpoint.seen[0]!.body.messages;
    assert.deepEqual(sent.slice(1).map((m) => [m.role, m.content]), [["user", "first"], ["assistant", "the token is __FAIRWAY_SECRET_1__"], ["user", "second"]]);
    assert.match(sent[0]!.content, /other\.test/);
    assert.match(sent[0]!.content, /Findings: none/);
  } finally {
    await endpoint.close();
  }
});

test("a turn cut off by the token cap ends with a clear message", async () => {
  const endpoint = await fakeEndpoint([{ chunks: [{ choices: [{ delta: { content: "partial" } }] }, { choices: [{ delta: {}, finish_reason: "length" }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4000 } }] }]);
  try {
    const events = await collect(runTurn({ endpoint: { baseUrl: endpoint.baseUrl, apiKey: null }, model: "model-a", validate: async () => [] }, { text: CADDYFILE, messages: [{ role: "user", content: "long please" }] }));
    assert.deepEqual(events.map((e) => e.type), ["text", "usage", "limit"]);
    assert.match((events[2] as { message: string }).message, /limit of 4000 tokens/);
  } finally {
    await endpoint.close();
  }
});

test("an endpoint error ends the turn with its reason", async () => {
  const endpoint = await fakeEndpoint([{ status: 429 }]);
  try {
    const events = await collect(runTurn({ endpoint: { baseUrl: endpoint.baseUrl, apiKey: null }, model: "model-a", validate: async () => [] }, { text: CADDYFILE, messages: [{ role: "user", content: "hi" }] }));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "error");
    assert.match((events[0] as { error: string }).error, /limiting requests/);
  } finally {
    await endpoint.close();
  }
});

test("a failing validation does not stop the turn", async () => {
  const endpoint = await fakeEndpoint([{ chunks: answer("ok") }]);
  try {
    const events = await collect(runTurn({ endpoint: { baseUrl: endpoint.baseUrl, apiKey: null }, model: "model-a", validate: async () => Promise.reject(new Error("down")) }, { text: CADDYFILE, messages: [{ role: "user", content: "hi" }] }));
    assert.equal(events[0]!.type, "text");
  } finally {
    await endpoint.close();
  }
});

test("aborting a turn stops the request to the model", async () => {
  const endpoint = await fakeEndpoint([{ hang: true }]);
  try {
    const controller = new AbortController();
    const events: TurnEvent[] = [];
    for await (const e of runTurn({ endpoint: { baseUrl: endpoint.baseUrl, apiKey: null }, model: "model-a", validate: async () => [], signal: controller.signal }, { text: CADDYFILE, messages: [{ role: "user", content: "hi" }] })) {
      events.push(e);
      if (e.type === "text") controller.abort();
    }
    assert.equal(events.at(-1)?.type, "error");
    assert.equal((events.at(-1) as { reason: string }).reason, "aborted");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(endpoint.closedByClient(), true);
  } finally {
    await endpoint.close();
  }
});

// ---- the edit tool and Proposals ----

const toolCall = (id: string, args: unknown) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "edit_caddyfile", arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
];
const edit = (oldText: string, newText: string) => ({ edits: [{ old_text: oldText, new_text: newText }] });
const deps = (endpoint: { baseUrl: string }) => ({ endpoint: { baseUrl: endpoint.baseUrl, apiKey: null }, model: "model-a", validate: async () => [] as Finding[] });
const ask = (content: string) => ({ text: CADDYFILE, messages: [{ role: "user" as const, content }] });

test("a tool call becomes one Proposal with the secret restored, and the model reads the result", async () => {
  const endpoint = await fakeEndpoint([
    { chunks: toolCall("c1", edit("app:8080", "app:9090")) },
    { chunks: answer("I proposed the change.") },
  ]);
  try {
    const events = await collect(runTurn(deps(endpoint), ask("use port 9090")));
    assert.deepEqual(events.map((e) => e.type), ["validating", "text", "usage", "proposal"]);
    assert.deepEqual(events[2], { type: "usage", usage: { promptTokens: 220, completionTokens: 25 } });
    assert.deepEqual(proposalOf(events), { type: "proposal", text: CADDYFILE.replace("app:8080", "app:9090"), valid: true, findings: [], attempts: 1 });
    const second = endpoint.seen[1]!.body.messages as Array<{ role: string; content: string; tool_call_id?: string }>;
    assert.equal(second.at(-2)!.role, "assistant");
    assert.equal(second.at(-1)!.role, "tool");
    assert.equal(second.at(-1)!.tool_call_id, "c1");
    assert.match(second.at(-1)!.content, /Applied 1 edit/);
    assert.ok(!JSON.stringify(endpoint.seen).includes(SECRET));
  } finally {
    await endpoint.close();
  }
});

test("a secret the model leaves alone shows no difference, and an edit around it keeps the real value", async () => {
  const endpoint = await fakeEndpoint([{ chunks: toolCall("c1", edit("\treverse_proxy app:8080", "\treverse_proxy app:8080\n\tencode gzip")) }, { chunks: answer("done") }]);
  try {
    const events = await collect(runTurn(deps(endpoint), ask("compress")));
    const proposal = events.find((e) => e.type === "proposal") as { text: string };
    assert.ok(proposal.text.includes(`header_up Authorization ${SECRET}`));
    assert.ok(!proposal.text.includes("__FAIRWAY_SECRET"));
  } finally {
    await endpoint.close();
  }
});

test("edits that do not apply are reported to the model, which may try again; several calls make one Proposal", async () => {
  const endpoint = await fakeEndpoint([
    { chunks: toolCall("c1", edit("nothing like this", "x")) },
    { chunks: toolCall("c2", edit("app:8080", "app:1")) },
    { chunks: toolCall("c3", { edits: [{ old_text: "", new_text: "b.test {\n\trespond ok\n}" }] }) },
    { chunks: answer("done") },
  ]);
  try {
    const events = await collect(runTurn(deps(endpoint), ask("change")));
    assert.equal(events.filter((e) => e.type === "proposal").length, 1);
    const proposal = (events.find((e) => e.type === "proposal") as { text: string }).text;
    assert.ok(proposal.includes("app:1\n") && proposal.endsWith("\nb.test {\n\trespond ok\n}\n"));
    const second = endpoint.seen[1]!.body.messages as Array<{ role: string; content: string }>;
    assert.match(second.at(-1)!.content, /not found/);
  } finally {
    await endpoint.close();
  }
});

test("without an applied edit there is no Proposal", async () => {
  const endpoint = await fakeEndpoint([{ chunks: toolCall("c1", edit("nothing like this", "x")) }, { chunks: answer("sorry") }]);
  try {
    const events = await collect(runTurn(deps(endpoint), ask("change")));
    assert.ok(!events.some((e) => e.type === "proposal"));
  } finally {
    await endpoint.close();
  }
});

test("a placeholder the model invented is reported and no Proposal is made", async () => {
  const endpoint = await fakeEndpoint([{ chunks: toolCall("c1", edit("app:8080", "app:8080\n\theader_up X-Key __FAIRWAY_SECRET_9__")) }, { chunks: answer("done") }]);
  try {
    const events = await collect(runTurn(deps(endpoint), ask("add a key")));
    assert.ok(!events.some((e) => e.type === "proposal"));
    const error = events.at(-1) as { type: string; reason: string; error: string };
    assert.equal(error.type, "error");
    assert.equal(error.reason, "unknown_placeholder");
    assert.match(error.error, /nothing was changed/);
  } finally {
    await endpoint.close();
  }
});

test("a turn has a hard limit on tool calls; the last round is sent without the tool", async () => {
  const endpoint = await fakeEndpoint([{ chunks: toolCall("c", edit("nothing", "x")) }]);
  try {
    const events = await collect(runTurn(deps(endpoint), ask("loop")));
    assert.equal(endpoint.seen.length, ASSISTANT_LIMITS.maxToolCalls + 1);
    assert.equal(endpoint.seen.at(-1)!.body.tools, undefined);
    assert.equal(events.at(-1)!.type, "limit");
    assert.match((events.at(-1) as { message: string }).message, /6 tool calls/);
  } finally {
    await endpoint.close();
  }
});

test("the only tool the model is offered edits the text; nothing can deploy, reload or roll back", async () => {
  const endpoint = await fakeEndpoint([{ chunks: answer("hi") }]);
  try {
    await collect(runTurn(deps(endpoint), ask("hi")));
    const tools = (endpoint.seen[0]!.body as unknown as { tools: Array<{ function: { name: string } }> }).tools;
    assert.deepEqual(tools.map((t) => t.function.name), ["edit_caddyfile"]);
  } finally {
    await endpoint.close();
  }
});

test("the system prompt tells the model it proposes and never claims a change is live", () => {
  const prompt = buildSystemPrompt(maskCaddyfile(CADDYFILE), []);
  assert.match(prompt, /edit_caddyfile/);
  assert.match(prompt, /Never say a change is live/);
  assert.match(prompt, /smallest change/);
});

test("the turn endpoint streams the proposal event before done", async () => {
  const endpoint = await fakeEndpoint([{ chunks: toolCall("c1", edit("app:8080", "app:9090")) }, { chunks: answer("ok") }]);
  const r = await rig({ login: true, baseUrl: endpoint.baseUrl, model: "model-a" });
  try {
    const body = await (await r.turn(goodBody)).text();
    assert.deepEqual([...body.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]).filter((name) => name !== "context" && name !== "step"), ["conversation", "validating", "text", "usage", "proposal", "done"]);
    assert.match(body, new RegExp(`"text":"[^"]*${SECRET}`));
  } finally {
    await Promise.all([r.cleanup(), endpoint.close()]);
  }
});

// ---- the model checks its own draft ----

const caddyError = (message: string, line: number): Finding => ({ level: "error", message, line, origin: "caddy" });

/** A validate function: the first call is the buffer's own Findings, the rest answer from a script, one per call. */
function scriptedValidate(answers: Finding[][]) {
  const seen: string[] = [];
  let first = true;
  return {
    seen,
    validate: async (text: string) => {
      if (first) return (first = false), [] as Finding[];
      return answers[Math.min(seen.push(text) - 1, answers.length - 1)]!;
    },
  };
}

const validating = (events: TurnEvent[]) => events.filter((e) => e.type === "validating");
/** The proposal event without its masked copy for the store, which has its own tests. */
const proposalOf = (events: TurnEvent[]) => {
  const { stored: _stored, ...rest } = events.find((e) => e.type === "proposal") as Extract<TurnEvent, { type: "proposal" }>;
  return rest;
};

test("a draft that passes the first time is valid after one attempt, with its warnings", async () => {
  const endpoint = await fakeEndpoint([{ chunks: toolCall("c1", edit("app:8080", "app:9090")) }, { chunks: answer("Proposed.") }]);
  const note: Finding = { level: "warning", message: `Careful with ${SECRET}`, line: 2, origin: "rules" };
  const v = scriptedValidate([[note]]);
  try {
    const events = await collect(runTurn({ ...deps(endpoint), validate: v.validate }, ask("port")));
    assert.deepEqual(validating(events), [{ type: "validating", attempt: 1 }]);
    assert.deepEqual(proposalOf(events), { type: "proposal", text: CADDYFILE.replace("app:8080", "app:9090"), valid: true, findings: [note], attempts: 1 });
    assert.equal(v.seen.length, 1, "the final draft was already validated, so it is not validated again");
    assert.ok(v.seen[0]!.includes(SECRET), "Validation sees the real secrets");
    const result = (endpoint.seen[1]!.body.messages as Array<{ role: string; content: string }>).at(-1)!.content;
    assert.match(result, /Applied 1 edit/);
    assert.match(result, /valid, Caddy accepts/);
    assert.match(result, /warning, line 2: Careful with __FAIRWAY_SECRET_1__/);
    assert.ok(!JSON.stringify(endpoint.seen).includes(SECRET), "findings are masked before the model reads them");
  } finally {
    await endpoint.close();
  }
});

test("error Findings go back to the model with their lines, and a correction ends valid in two attempts", async () => {
  const endpoint = await fakeEndpoint([
    { chunks: toolCall("c1", edit("reverse_proxy app:8080", "reverse_proxy_typo app:9090")) },
    { chunks: toolCall("c2", edit("reverse_proxy_typo", "reverse_proxy")) },
    { chunks: answer("Fixed.") },
  ]);
  const v = scriptedValidate([[caddyError(`unrecognized directive near ${SECRET}`, 3)], []]);
  try {
    const events = await collect(runTurn({ ...deps(endpoint), validate: v.validate }, ask("change")));
    assert.deepEqual(validating(events), [{ type: "validating", attempt: 1 }, { type: "validating", attempt: 2 }]);
    const proposal = proposalOf(events);
    assert.equal(proposal.valid, true);
    assert.equal(proposal.attempts, 2);
    assert.equal(proposal.text, CADDYFILE.replace("app:8080", "app:9090"));
    const afterFirst = (endpoint.seen[1]!.body.messages as Array<{ role: string; content: string }>).at(-1)!.content;
    assert.match(afterFirst, /does not accept/);
    assert.match(afterFirst, /error, line 3: unrecognized directive near __FAIRWAY_SECRET_1__/);
    assert.match(afterFirst, /2 attempts left/);
    assert.ok(!JSON.stringify(endpoint.seen).includes(SECRET));
  } finally {
    await endpoint.close();
  }
});

test("three failed attempts end the tools; the Proposal is shown not valid with its error Findings", async () => {
  const endpoint = await fakeEndpoint([
    { chunks: toolCall("c1", edit("app:8080", "app:1")) },
    { chunks: toolCall("c2", edit("app:1", "app:2")) },
    { chunks: toolCall("c3", edit("app:2", "app:3")) },
    { chunks: answer("I could not fix it.") },
  ]);
  const errorFinding = caddyError("still wrong", 2);
  const v = scriptedValidate([[errorFinding]]);
  try {
    const events = await collect(runTurn({ ...deps(endpoint), validate: v.validate }, ask("change")));
    assert.equal(validating(events).length, 3);
    assert.equal(endpoint.seen.length, 4);
    assert.equal(endpoint.seen[2]!.body.tools !== undefined, true);
    assert.equal(endpoint.seen[3]!.body.tools, undefined, "no tools after the third failure");
    assert.match((endpoint.seen[3]!.body.messages as Array<{ content: string }>).at(-1)!.content, /no tools now/);
    assert.deepEqual(proposalOf(events), { type: "proposal", text: CADDYFILE.replace("app:8080", "app:3"), valid: false, findings: [errorFinding], attempts: 3 });
    assert.ok(!events.some((e) => e.type === "limit"));
  } finally {
    await endpoint.close();
  }
});

test("a model that calls the tool after its attempts are used up is refused and the turn ends", async () => {
  const endpoint = await fakeEndpoint([{ chunks: toolCall("c", edit("", "b.test {\n\trespond ok\n}")) }]);
  const v = scriptedValidate([[caddyError("no", 1)]]);
  try {
    const events = await collect(runTurn({ ...deps(endpoint), validate: v.validate }, ask("change")));
    assert.equal(v.seen.length, 3, "validated three times, never a fourth");
    assert.equal(proposalOf(events).attempts, 3);
    assert.equal(proposalOf(events).valid, false);
  } finally {
    await endpoint.close();
  }
});

test("an edit that does not apply is not a Validation attempt, and warnings alone never make a Proposal not valid", async () => {
  const endpoint = await fakeEndpoint([{ chunks: toolCall("c1", edit("nothing like this", "x")) }, { chunks: toolCall("c2", edit("app:8080", "app:1")) }, { chunks: answer("ok") }]);
  const v = scriptedValidate([[{ level: "warning", message: "w", origin: "caddy" }]]);
  try {
    const events = await collect(runTurn({ ...deps(endpoint), validate: v.validate }, ask("change")));
    assert.equal(v.seen.length, 1);
    assert.equal(proposalOf(events).valid, true);
    assert.equal(proposalOf(events).attempts, 1);
  } finally {
    await endpoint.close();
  }
});

test("the system prompt tells the model that Caddy checks each edit", () => {
  const prompt = buildSystemPrompt(maskCaddyfile(CADDYFILE), []);
  assert.match(prompt, /checked by Caddy/);
  assert.match(prompt, /another edit/);
  assert.match(prompt, /do not restate the whole file/);
});

test("Validation in a turn only adapts: nothing is loaded and the Caddyfile on disk is unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ce-assistant-admin-"));
  const socket = join(dir, "admin.sock");
  const requests: string[] = [];
  const caddy = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(req.url === "/adapt" ? 200 : 404, { "Content-Type": "application/json" });
      res.end(req.url === "/adapt" ? JSON.stringify({ result: {}, warnings: [] }) : "{}");
    });
  });
  await new Promise<void>((resolve) => caddy.listen(socket, resolve));
  const endpoint = await fakeEndpoint([{ chunks: toolCall("c1", edit("app:8080", "app:9090")) }, { chunks: answer("ok") }]);
  const caddyfile = join(dir, "Caddyfile");
  await writeFile(caddyfile, CADDYFILE);
  const config = loadConfig({ ADMIN_SOCKET: socket, CADDYFILE_PATH: caddyfile, DATA_DIR: join(dir, "data"), LOG_DIR: dir, WEB_ROOT: dir, AI_BASE_URL: endpoint.baseUrl, AI_ASSISTANT_MODEL: "model-a", AUTH_USER: "owner", AUTH_PASSWORD: "correct horse battery" });
  const shutdown: Array<() => Promise<void>> = [];
  const app = await createApp(config, shutdown);
  try {
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "owner", password: "correct horse battery" }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    requests.length = 0;
    const res = await app.request("/api/assistant/turn", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(goodBody) });
    const body = await res.text();
    assert.match(body, /event: proposal/);
    assert.match(body, /"valid":true/);
    assert.ok(requests.includes("POST /adapt"));
    assert.deepEqual(requests.filter((r) => r !== "POST /adapt"), [], "nothing but adapt is called");
    assert.equal(await readFile(caddyfile, "utf8"), CADDYFILE);
  } finally {
    await Promise.allSettled(shutdown.map((fn) => fn()));
    await endpoint.close();
    await new Promise<void>((resolve) => caddy.close(() => resolve()));
  }
});

// ---- through the app ----

async function rig(options: { login: boolean; baseUrl?: string; model?: string }) {
  const dir = await mkdtemp(join(tmpdir(), "ce-assistant-"));
  const caddyfile = join(dir, "Caddyfile");
  await writeFile(caddyfile, CADDYFILE);
  const config = loadConfig({
    ADMIN_SOCKET: join(dir, "missing.sock"),
    CADDYFILE_PATH: caddyfile,
    DATA_DIR: join(dir, "data"),
    LOG_DIR: dir,
    WEB_ROOT: dir,
    ...(options.baseUrl && { AI_BASE_URL: options.baseUrl }),
    ...(options.model && { AI_ASSISTANT_MODEL: options.model }),
    ...(options.login && { AUTH_USER: "owner", AUTH_PASSWORD: "correct horse battery" }),
  });
  const shutdown: Array<() => Promise<void>> = [];
  const app = await createApp(config, shutdown);
  let cookie = "";
  if (options.login) {
    const res = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "owner", password: "correct horse battery" }) });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }
  const turn = (body: unknown, signedIn = true) =>
    app.request("/api/assistant/turn", { method: "POST", headers: { "Content-Type": "application/json", ...(cookie && signedIn && { Cookie: cookie }) }, body: JSON.stringify(body) });
  return { turn, cleanup: () => Promise.allSettled(shutdown.map((fn) => fn())) };
}

const goodBody = { conversationId: null, text: CADDYFILE, message: "What does this do?" };

test("the turn endpoint needs a Session, a login to be configured, and a model", async () => {
  const endpoint = await fakeEndpoint([{ chunks: answer("hello") }]);
  const noLogin = await rig({ login: false, baseUrl: endpoint.baseUrl, model: "model-a" });
  const noModel = await rig({ login: true, baseUrl: endpoint.baseUrl });
  const ready = await rig({ login: true, baseUrl: endpoint.baseUrl, model: "model-a" });
  try {
    assert.equal((await noLogin.turn(goodBody)).status, 403);
    assert.equal((await noModel.turn(goodBody)).status, 409);
    assert.equal((await ready.turn(goodBody, false)).status, 401);
    assert.equal((await ready.turn({ conversationId: null, text: "x", message: " " })).status, 400);
    assert.equal(endpoint.seen.length, 0);
  } finally {
    await Promise.all([noLogin.cleanup(), noModel.cleanup(), ready.cleanup(), endpoint.close()]);
  }
});

test("the turn endpoint streams text, usage and a final done event, with the secret masked", async () => {
  const endpoint = await fakeEndpoint([{ chunks: answer("hello") }]);
  const r = await rig({ login: true, baseUrl: endpoint.baseUrl, model: "model-a" });
  try {
    const res = await r.turn(goodBody);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const body = await res.text();
    assert.deepEqual([...body.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]).filter((name) => name !== "context" && name !== "step"), ["conversation", "text", "usage", "done"]);
    assert.match(body, /data: {"delta":"hello"}/);
    assert.match(body, /data: {"usage":{"promptTokens":120,"completionTokens":15}}/);
    assert.ok(!JSON.stringify(endpoint.seen).includes(SECRET));
  } finally {
    await Promise.all([r.cleanup(), endpoint.close()]);
  }
});

test("a later round of text starts a new paragraph only after a finished sentence or line, never in the middle of one", () => {
  assert.equal(startsNewParagraph("I will add that.", "Done."), true);
  assert.equal(startsNewParagraph("These are the sites:\n", "| a | b |"), true);
  // Interrupted inside a table cell, the model carries on where it stopped.
  assert.equal(startsNewParagraph("| Site | Port | Log block | Log", " file |"), false);
  assert.equal(startsNewParagraph("The Site answers", "on port 8080"), false);
  assert.equal(startsNewParagraph("It is done.", " Next"), false);
});

test("a turn starts with the parts its request is made of, and they add up to what the system prompt holds", async () => {
  const endpoint = await fakeEndpoint([{ chunks: [{ choices: [{ delta: { content: "ok" } }] }] }]);
  try {
    const request = { text: CADDYFILE, messages: [{ role: "user" as const, content: "what does this do?" }] };
    const events: TurnEvent[] = [];
    for await (const e of runTurn({ endpoint: { baseUrl: endpoint.baseUrl, apiKey: null }, model: "model-a", validate: async () => [warning] }, request)) events.push(e);
    const first = events.find((e) => e.type === "context")!;
    const parts = first.type === "context" ? first.parts : [];
    assert.deepEqual(parts.map((p) => p.key), ["instructions", "placeholders", "caddyfile", "findings", "tool", "conversation"]);
    const prompt = buildSystemPrompt(maskCaddyfile(CADDYFILE), [warning]);
    const system = parts.filter((p) => ["instructions", "placeholders", "caddyfile", "proposal", "findings"].includes(p.key)).reduce((sum, p) => sum + p.tokens, 0);
    // The prompt is its parts joined by blank lines, so the estimate differs by rounding and those joins only.
    assert.ok(Math.abs(system - Math.ceil(prompt.length / 4)) <= parts.length);
    assert.equal(parts.find((p) => p.key === "caddyfile")!.tokens > parts.find((p) => p.key === "findings")!.tokens, true);
  } finally {
    await endpoint.close();
  }
});

test("a turn reports what ran: the check of the buffer, each round with the model, each edit and each Validation", async () => {
  const endpoint = await fakeEndpoint([{ chunks: toolCall("c1", edit("app:8080", "app:9090")) }, { chunks: answer("Done.") }]);
  try {
    const steps: TurnStep[] = [];
    for await (const e of runTurn(deps(endpoint), ask("use port 9090"))) if (e.type === "step") steps.push(e.step);
    assert.deepEqual(steps.map((s) => s.kind), ["checked", "model", "edit", "validate", "model"]);
    assert.deepEqual(steps[2], { kind: "edit", applied: true, edits: 1 });
    const validate = steps[3]!;
    assert.equal(validate.kind === "validate" && validate.attempt, 1);
    for (const step of steps) if ("ms" in step) assert.ok(Number.isInteger(step.ms) && step.ms >= 0);
    // Nothing of the Caddyfile is in a step.
    assert.equal(JSON.stringify(steps).includes("9090"), false);
  } finally {
    await endpoint.close();
  }
});

// ---- looking things up ----

const lookupCall = (id: string, name: string, args: unknown = {}) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
];

/** A stand-in for the lookups: answers every call with the next content and remembers what it was asked. */
function fakeLookup(contents: Array<{ content: string; condensed?: string | null }>, allowed = 5) {
  const asked: string[] = [];
  const lookup = {
    tools: [{ name: "get_routes", description: "routes", parameters: { type: "object" } }, { name: "get_log_lines", description: "log", parameters: { type: "object" } }],
    session: () => {
      let calls = 0;
      return {
        available: () => calls < allowed,
        run: async (call: { name: string; arguments: string }, mask: (text: string) => string) => {
          const next = contents[Math.min(calls++, contents.length - 1)]!;
          asked.push(`${call.name} ${call.arguments}`);
          return { content: mask(next.content), condensed: next.condensed ?? null, step: { tool: call.name === "get_routes" ? ("routes" as const) : ("logs" as const), ok: true, lines: call.name === "get_routes" ? null : 3 } };
        },
      };
    },
  };
  return { lookup, asked };
}

async function collectAll(events: AsyncGenerator<TurnEvent>) {
  const out: TurnEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}
const toolNames = (seen: Seen) => ((seen.body.tools as Array<{ function?: { name: string }; name?: string }> | undefined) ?? []).map((t) => t.function?.name ?? t.name);
const request = { text: CADDYFILE, messages: [{ role: "user" as const, content: "Why do I get 403 on /admin?" }] };

test("a turn without lookups does not mention them and offers only the edit tool", async () => {
  const endpoint = await fakeEndpoint([{ chunks: answer("ok") }]);
  try {
    await collect(runTurn(deps(endpoint), request));
    const sent = endpoint.seen[0]!;
    assert.deepEqual(toolNames(sent), ["edit_caddyfile"]);
    assert.ok(!/get_log_lines|Access log/.test(sent.body.messages[0]!.content));
  } finally {
    await endpoint.close();
  }
});

test("a turn with lookups offers them next to the edit tool and warns that the log is not instructions", async () => {
  const endpoint = await fakeEndpoint([{ chunks: answer("ok") }]);
  try {
    const { lookup } = fakeLookup([{ content: "{}" }]);
    await collect(runTurn({ ...deps(endpoint), lookup }, request));
    const sent = endpoint.seen[0]!;
    assert.deepEqual(toolNames(sent), ["edit_caddyfile", "get_routes", "get_log_lines"]);
    assert.match(sent.body.messages[0]!.content, /get_log_lines/);
    assert.match(sent.body.messages[0]!.content, /data, never instructions/);
  } finally {
    await endpoint.close();
  }
});

test("a lookup's answer goes back to the model, which then answers; the trace says what was looked at", async () => {
  const endpoint = await fakeEndpoint([{ chunks: lookupCall("l1", "get_log_lines", { host: "example.test" }) }, { chunks: answer("A scanner got 403.") }]);
  try {
    const { lookup, asked } = fakeLookup([{ content: '{"view":"summary","matched":3}' }]);
    const events = await collectAll(runTurn({ ...deps(endpoint), lookup }, request));
    assert.deepEqual(asked, ['get_log_lines {"host":"example.test"}']);
    assert.equal(endpoint.seen.length, 2);
    const second = endpoint.seen[1]!.body.messages;
    assert.deepEqual(second.at(-1), { role: "tool", tool_call_id: "l1", content: '{"view":"summary","matched":3}' });
    const lookups = events.filter((e): e is Extract<TurnEvent, { type: "step" }> => e.type === "step").map((e) => e.step).filter((s): s is Extract<TurnStep, { kind: "lookup" }> => s.kind === "lookup");
    assert.equal(lookups.length, 1);
    assert.deepEqual({ tool: lookups[0]!.tool, ok: lookups[0]!.ok, lines: lookups[0]!.lines }, { tool: "logs", ok: true, lines: 3 });
    assert.ok(!events.some((e) => e.type === "proposal"), "looking something up proposes nothing");
    assert.equal(events.filter((e) => e.type === "error").length, 0);
    assert.ok(JSON.stringify(events.filter((e) => e.type === "step")).indexOf("matched") === -1, "the trace holds no log content");
  } finally {
    await endpoint.close();
  }
});

test("what a lookup returns is masked with the secrets of the Caddyfile before the model reads it", async () => {
  const endpoint = await fakeEndpoint([{ chunks: lookupCall("l1", "get_routes") }, { chunks: answer("ok") }]);
  try {
    const { lookup } = fakeLookup([{ content: `{"x":"${SECRET}"}` }]);
    await collectAll(runTurn({ ...deps(endpoint), lookup }, request));
    const sent = JSON.stringify(endpoint.seen[1]!.body);
    assert.ok(!sent.includes(SECRET));
    assert.match(sent, /__FAIRWAY_SECRET_1__/);
  } finally {
    await endpoint.close();
  }
});

test("rows read in an earlier round are replaced by their short form in the next request", async () => {
  const endpoint = await fakeEndpoint([
    { chunks: lookupCall("l1", "get_log_lines", { view: "rows" }) },
    { chunks: lookupCall("l2", "get_log_lines", { view: "rows" }) },
    { chunks: answer("done") },
  ]);
  try {
    const { lookup } = fakeLookup([{ content: "ROWS-ONE-LONG", condensed: "SHORT-ONE" }, { content: "ROWS-TWO-LONG", condensed: "SHORT-TWO" }]);
    await collectAll(runTurn({ ...deps(endpoint), lookup }, request));
    const tools = (seen: Seen) => seen.body.messages.filter((m) => m.role === "tool").map((m) => m.content);
    assert.deepEqual(tools(endpoint.seen[1]!), ["ROWS-ONE-LONG"]);
    assert.deepEqual(tools(endpoint.seen[2]!), ["SHORT-ONE", "ROWS-TWO-LONG"]);
  } finally {
    await endpoint.close();
  }
});

test("after the last lookup the next round is sent without the lookup tools, and the model answers", async () => {
  const endpoint = await fakeEndpoint([{ chunks: lookupCall("l1", "get_routes") }, { chunks: answer("here is what I found") }]);
  try {
    const { lookup } = fakeLookup([{ content: "{}" }], 1);
    const events = await collectAll(runTurn({ ...deps(endpoint), lookup }, request));
    assert.deepEqual(toolNames(endpoint.seen[0]!), ["edit_caddyfile", "get_routes", "get_log_lines"]);
    assert.deepEqual(toolNames(endpoint.seen[1]!), ["edit_caddyfile"]);
    assert.ok(events.some((e) => e.type === "text" && e.delta === "here is what I found"));
  } finally {
    await endpoint.close();
  }
});

test("a lookup beyond the limit in one round is refused, and the turn goes on", async () => {
  const two = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "get_routes", arguments: "{}" } }, { index: 1, id: "b", function: { name: "get_routes", arguments: "{}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
  const endpoint = await fakeEndpoint([{ chunks: two }, { chunks: answer("ok") }]);
  try {
    const { lookup, asked } = fakeLookup([{ content: "{}" }], 1);
    const events = await collectAll(runTurn({ ...deps(endpoint), lookup }, request));
    assert.equal(asked.length, 1);
    const tools = endpoint.seen[1]!.body.messages.filter((m) => m.role === "tool");
    assert.match(tools[1]!.content, /Not run: the limit of lookups/);
    assert.ok(events.some((e) => e.type === "text"));
  } finally {
    await endpoint.close();
  }
});

test("a model that calls a lookup it was not offered ends the turn instead of looping", async () => {
  const endpoint = await fakeEndpoint([{ chunks: lookupCall("l1", "get_routes") }]);
  try {
    const { lookup, asked } = fakeLookup([{ content: "{}" }], 0);
    await collectAll(runTurn({ ...deps(endpoint), lookup }, request));
    assert.equal(asked.length, 0);
    assert.equal(endpoint.seen.length, 1);
  } finally {
    await endpoint.close();
  }
});

test("a lookup and an edit in one turn still give a Proposal", async () => {
  const endpoint = await fakeEndpoint([{ chunks: lookupCall("l1", "get_routes", { host: "example.test" }) }, { chunks: toolCall("e1", edit("app:8080", "app:9090")) }, { chunks: answer("Changed the upstream.") }]);
  try {
    const { lookup } = fakeLookup([{ content: "{}" }]);
    const events = await collectAll(runTurn({ ...deps(endpoint), lookup }, { text: CADDYFILE, messages: [{ role: "user", content: "Point it at 9090" }] }));
    const proposal = events.find((e): e is Extract<TurnEvent, { type: "proposal" }> => e.type === "proposal");
    assert.ok(proposal);
    assert.match(proposal.text, /app:9090/);
  } finally {
    await endpoint.close();
  }
});
