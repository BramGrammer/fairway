import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { checkTurnBody, startConversationTurn, toModelMessages, type ConversationEvent, type TurnBody } from "../src/server/conversation-turn.js";
import { CONVERSATION_RETENTION_MS, Conversations, MAX_CONVERSATIONS, placeholderKey } from "../src/server/conversations.js";
import type { Finding } from "../src/server/findings.js";
import { maskCaddyfile } from "../src/server/masking.js";

const SECRET = "fake-token-value-123";
const OTHER_SECRET = "second-fake-token-456";
const TYPED_SECRET = "typed-by-the-owner-789";
const CADDYFILE = `example.test {\n\theader_up Authorization ${SECRET}\n\treverse_proxy app:8080\n}\n`;

const listen = (server: Server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";

interface Seen {
  body: { messages: Array<{ role: string; content: string }> };
}

/** A stand-in model endpoint: answers each chat call with the next script step and remembers what it was sent. */
async function fakeEndpoint(steps: Array<{ status?: number; chunks?: unknown[] }>) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seen.push({ body: JSON.parse(raw) });
      const step = steps[Math.min(seen.length - 1, steps.length - 1)]!;
      res.writeHead(step.status ?? 200, { "Content-Type": step.status && step.status >= 400 ? "application/json" : "text/event-stream" });
      res.end(step.status && step.status >= 400 ? "{}" : sse(step.chunks ?? []));
    });
  });
  await listen(server);
  return { seen, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => close(server) };
}

const answer = (text: string) => [
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
];
const toolCall = (id: string, args: unknown) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "edit_caddyfile", arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
];
const edit = (oldText: string, newText: string) => ({ edits: [{ old_text: oldText, new_text: newText }] });
/** A turn that edits the Caddyfile, then answers. */
const editing = (oldText: string, newText: string, words = "Proposed.") => [{ chunks: toolCall("c1", edit(oldText, newText)) }, { chunks: answer(words) }];

async function rig(steps: Array<{ chunks?: unknown[]; status?: number }>, options: { now?: () => number; findings?: Finding[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ce-conversations-"));
  const file = join(dir, "conversations.json");
  const endpoint = await fakeEndpoint(steps);
  const store = new Conversations({ file, key: placeholderKey(Buffer.alloc(32, 7)), now: options.now });
  const deps = { endpoint: { baseUrl: endpoint.baseUrl, apiKey: null }, model: "model-a", validate: async () => options.findings ?? [] };
  const turn = async (body: Partial<TurnBody> & { message: string }, signal?: AbortSignal) => {
    const started = startConversationTurn(store, { ...deps, signal }, { conversationId: null, text: CADDYFILE, pending: null, ...body });
    assert.ok(started.ok, started.ok ? "" : started.error);
    const events: ConversationEvent[] = [];
    for await (const event of started.events) events.push(event);
    return events;
  };
  return { dir, file, endpoint, store, turn, deps };
}

const idOf = (events: ConversationEvent[]) => (events[0] as { id: string }).id;
const proposalOf = (events: ConversationEvent[]) => events.find((e) => e.type === "proposal") as Extract<ConversationEvent, { type: "proposal" }> | undefined;

test("a Conversation is stored as it grows, listed newest first with a title, and survives a restart", async () => {
  let clock = 1_000_000;
  const r = await rig([{ chunks: answer("It proxies.") }], { now: () => clock });
  try {
    const first = await r.turn({ message: "What does this Site do?\nPlease explain in detail what each directive is for and why it is here." });
    clock += 60_000;
    const second = await r.turn({ message: "Another question" });
    const [newest, oldest] = r.store.list();
    assert.equal(newest!.id, idOf(second));
    assert.equal(oldest!.id, idOf(first));
    assert.ok(oldest!.title.startsWith("What does this Site do? Please explain"));
    assert.ok(oldest!.title.length <= 60);
    assert.equal(oldest!.updatedAt, 1_000_000);
    assert.equal(oldest!.messages, 2);

    const reloaded = new Conversations({ file: r.file, key: placeholderKey(Buffer.alloc(32, 7)), now: () => clock });
    await reloaded.load();
    assert.deepEqual(reloaded.list(), r.store.list());
    const stored = reloaded.get(idOf(first))!;
    assert.deepEqual(stored.messages.map((m) => [m.role, m.content]), [["user", "What does this Site do?\nPlease explain in detail what each directive is for and why it is here."], ["assistant", "It proxies."]]);
    assert.deepEqual(stored.usage, { promptTokens: 100, completionTokens: 10 });
  } finally {
    await r.endpoint.close();
  }
});

test("continuing sends the earlier messages and the editor buffer as it is now", async () => {
  const r = await rig([{ chunks: answer("one") }, { chunks: answer("two") }]);
  try {
    const first = await r.turn({ message: "first" });
    const edited = CADDYFILE.replace("app:8080", "app:9090");
    const events = await r.turn({ conversationId: idOf(first), text: edited, message: "second" });
    assert.equal(idOf(events), idOf(first));
    const sent = r.endpoint.seen[1]!.body.messages;
    assert.match(sent[0]!.content, /reverse_proxy app:9090/);
    assert.doesNotMatch(sent[0]!.content, /app:8080/);
    assert.deepEqual(sent.slice(1), [{ role: "user", content: "first" }, { role: "assistant", content: "one" }, { role: "user", content: "second" }]);
    assert.equal(r.store.get(idOf(first))!.messages.length, 4);
  } finally {
    await r.endpoint.close();
  }
});

test("a Conversation can be deleted, and a turn in one that is gone is refused", async () => {
  const r = await rig([{ chunks: answer("one") }]);
  try {
    const id = idOf(await r.turn({ message: "first" }));
    assert.equal(await r.store.delete(id), true);
    assert.equal(r.store.get(id), undefined);
    assert.deepEqual(r.store.list(), []);
    assert.equal(await r.store.delete(id), false);
    const refused = startConversationTurn(r.store, r.deps, { conversationId: id, text: CADDYFILE, message: "again", pending: null });
    assert.equal(refused.ok, false);
    assert.equal((refused as { status: number }).status, 404);
    const reloaded = new Conversations({ file: r.file, key: placeholderKey(Buffer.alloc(32, 7)) });
    await reloaded.load();
    assert.deepEqual(reloaded.list(), []);
  } finally {
    await r.endpoint.close();
  }
});

test("Conversations are removed 30 days after their last turn, on load and when a turn finishes", async () => {
  let clock = 5_000_000_000;
  const r = await rig([{ chunks: answer("a") }], { now: () => clock });
  try {
    const old = idOf(await r.turn({ message: "old" }));
    const kept = idOf(await r.turn({ message: "kept" }));
    clock += CONVERSATION_RETENTION_MS - 1000;
    await r.turn({ conversationId: kept, message: "still here" });
    assert.ok(r.store.get(old), "29 days and a bit is not enough to go");
    clock += 2000;
    // The next turn finishes more than 30 days after the first one's last turn and removes it.
    await r.turn({ conversationId: kept, message: "and again" });
    assert.equal(r.store.get(old), undefined);
    assert.ok(r.store.get(kept));
    const onDisk = JSON.parse(await readFile(r.file, "utf8")) as { conversations: Array<{ id: string }> };
    assert.deepEqual(onDisk.conversations.map((c) => c.id), [kept]);

    clock += CONVERSATION_RETENTION_MS + 1;
    const later = new Conversations({ file: r.file, key: placeholderKey(Buffer.alloc(32, 7)), now: () => clock });
    await later.load();
    assert.deepEqual(later.list(), []);
    assert.deepEqual((JSON.parse(await readFile(r.file, "utf8")) as { conversations: unknown[] }).conversations, []);
  } finally {
    await r.endpoint.close();
  }
});

test("only the newest Conversations are kept beyond the cap", async () => {
  let clock = 1_000_000;
  const store = new Conversations({ file: join(await mkdtemp(join(tmpdir(), "ce-conversations-")), "c.json"), key: Buffer.alloc(32), now: () => clock });
  const ids: string[] = [];
  for (let i = 0; i < MAX_CONVERSATIONS + 3; i++) {
    const c = store.create();
    c.messages.push({ id: 1, role: "user", content: `q${i}` });
    c.updatedAt = clock++;
    ids.push(c.id);
    store.prune();
  }
  const listed = store.list().map((c) => c.id);
  assert.equal(listed.length, MAX_CONVERSATIONS);
  assert.deepEqual(listed.slice(0, 1), [ids.at(-1)]);
  assert.ok(!listed.includes(ids[0]!) && !listed.includes(ids[2]!));
});

test("a secret keeps its placeholder for the whole Conversation, however the buffer changes", async () => {
  const r = await rig([{ chunks: answer("a") }, { chunks: answer("b") }]);
  try {
    const first = await r.turn({ message: "first" });
    // A second secret now comes before the first one in the buffer.
    const text = `other.test {\n\theader_up X-Key ${OTHER_SECRET}\n}\n${CADDYFILE}`;
    await r.turn({ conversationId: idOf(first), text, message: "second" });
    const system = r.endpoint.seen[1]!.body.messages[0]!.content;
    assert.match(system, /header_up Authorization __FAIRWAY_SECRET_1__/);
    assert.match(system, /header_up X-Key __FAIRWAY_SECRET_2__/);
    const numbers = r.store.get(idOf(first))!.numbering;
    assert.deepEqual(Object.values(numbers).sort(), [1, 2]);
    assert.ok(Object.keys(numbers).every((key) => /^[0-9a-f]{64}$/.test(key)), "hashes, not values");
  } finally {
    await r.endpoint.close();
  }
});

test("what is stored never contains a secret", async () => {
  const quoting: Finding = { level: "warning", message: `Secret ${SECRET} is written inline`, line: 2, origin: "rules" };
  const r = await rig([...editing("app:8080", "app:9090"), { chunks: toolCall("c2", edit("app:9090", "app:9091")) }, { chunks: answer("Revised.") }], { findings: [quoting] });
  try {
    const first = await r.turn({ message: `Move the upstream to 9090, my token is ${SECRET}` });
    const proposal = proposalOf(first)!;
    assert.ok(proposal.text.includes(SECRET), "the browser gets the real text for the live Proposal");
    // A revision builds on the pending Proposal, which has the real text in the page.
    await r.turn({ conversationId: idOf(first), message: `Also try ${TYPED_SECRET}`, pending: { messageId: proposal.messageId, text: proposal.text } });
    const file = await readFile(r.file, "utf8");
    for (const secret of [SECRET, OTHER_SECRET]) assert.ok(!file.includes(secret), `${secret} must not be stored`);
    const stored = JSON.parse(file) as { conversations: Array<{ messages: Array<{ proposal?: { text: string; baseText: string; findings: Array<{ message: string }> } }> }> };
    const proposals = stored.conversations[0]!.messages.flatMap((m) => (m.proposal ? [m.proposal] : []));
    assert.equal(proposals.length, 2);
    assert.match(proposals[0]!.text, /header_up Authorization __FAIRWAY_SECRET_1__/);
    assert.match(proposals[0]!.baseText, /header_up Authorization __FAIRWAY_SECRET_1__/);
    assert.equal(proposals[0]!.findings[0]!.message, "Secret __FAIRWAY_SECRET_1__ is written inline");
    assert.ok(!JSON.stringify(r.endpoint.seen).includes(SECRET), "and none left for the model");
  } finally {
    await r.endpoint.close();
  }
});

test("a follow-up while a Proposal is pending revises it, and the earlier one is shown as replaced", async () => {
  const r = await rig([...editing("app:8080", "app:9090"), ...editing("reverse_proxy app:9090", "reverse_proxy app:9090\n\tencode gzip", "Added.")]);
  try {
    const first = await r.turn({ message: "use 9090" });
    const one = proposalOf(first)!;
    const second = await r.turn({ conversationId: idOf(first), message: "also add compression", pending: { messageId: one.messageId, text: one.text } });
    const two = proposalOf(second)!;
    // The model edited the pending text, so its edit found 9090 and the result holds both changes.
    assert.match(two.text, /app:9090\n\tencode gzip/);
    assert.match(two.text, new RegExp(`Authorization ${SECRET}`));
    const prompt = r.endpoint.seen[2]!.body.messages[0]!.content;
    assert.match(prompt, /A Proposal of yours is pending/);
    assert.match(prompt, /reverse_proxy app:9090/);
    assert.ok(!r.endpoint.seen[0]!.body.messages[0]!.content.includes("is pending"));
    const states = r.store.get(idOf(first))!.messages.flatMap((m) => (m.proposal ? [m.proposal.status] : []));
    assert.deepEqual(states, ["replaced", "pending"]);
    // The stored difference of the new Proposal is against the editor buffer, not against the pending one.
    const stored = r.store.get(idOf(first))!.messages.at(-1)!.proposal!;
    assert.match(stored.baseText, /app:8080/);
    assert.match(stored.text, /encode gzip/);
  } finally {
    await r.endpoint.close();
  }
});

test("a turn that makes no edit leaves the pending Proposal as it is", async () => {
  const r = await rig([...editing("app:8080", "app:9090"), { chunks: answer("It uses 9090.") }]);
  try {
    const first = await r.turn({ message: "use 9090" });
    const one = proposalOf(first)!;
    const second = await r.turn({ conversationId: idOf(first), message: "what port is that?", pending: { messageId: one.messageId, text: one.text } });
    assert.equal(proposalOf(second), undefined);
    const states = r.store.get(idOf(first))!.messages.flatMap((m) => (m.proposal ? [m.proposal.status] : []));
    assert.deepEqual(states, ["pending"]);
  } finally {
    await r.endpoint.close();
  }
});

test("a pending Proposal the page no longer holds is outdated, and an outdated one is not revised", async () => {
  const r = await rig([...editing("app:8080", "app:9090"), { chunks: answer("ok") }]);
  try {
    const first = await r.turn({ message: "use 9090" });
    await r.turn({ conversationId: idOf(first), message: "anything" });
    const proposal = r.store.get(idOf(first))!.messages.find((m) => m.proposal)!.proposal!;
    assert.equal(proposal.status, "outdated");
    assert.doesNotMatch(r.endpoint.seen[2]!.body.messages[0]!.content, /is pending/);
  } finally {
    await r.endpoint.close();
  }
});

test("the page can mark a pending Proposal outdated, accepted or rejected, once", async () => {
  const r = await rig(editing("app:8080", "app:9090"));
  try {
    const first = await r.turn({ message: "use 9090" });
    const id = idOf(first);
    const messageId = proposalOf(first)!.messageId;
    assert.equal(r.store.decide(id, messageId, "outdated"), "ok");
    assert.equal(r.store.get(id)!.messages.find((m) => m.id === messageId)!.proposal!.status, "outdated");
    assert.equal(r.store.decide(id, messageId, "accepted"), "settled");
    assert.equal(r.store.decide(id, 99, "accepted"), "missing");
    assert.equal(r.store.decide("nope", messageId, "accepted"), "missing");
  } finally {
    await r.endpoint.close();
  }
});

test("the model is told what became of each earlier Proposal", () => {
  const proposal = { valid: true, attempts: 1, findings: [], baseText: "a", text: "b" };
  const note = (status: "pending" | "accepted" | "rejected" | "replaced" | "outdated") =>
    toModelMessages([{ id: 1, role: "assistant", content: "Here.", proposal: { ...proposal, status } }])[0]!.content;
  assert.match(note("accepted"), /accepted it into the editor/);
  assert.match(note("rejected"), /rejected it/);
  assert.match(note("replaced"), /replaced it/);
  assert.match(note("outdated"), /can no longer be accepted/);
  assert.match(note("pending"), /not decided/);
});

test("a stopped turn keeps its partial answer, and a failed one is not kept", async () => {
  const r = await rig([{ chunks: answer("a") }, { status: 500 }]);
  try {
    const first = await r.turn({ message: "first" });
    // The page stops reading after the first event, as a closed request does.
    const started = startConversationTurn(r.store, r.deps, { conversationId: idOf(first), text: CADDYFILE, message: "second", pending: null });
    assert.ok(started.ok);
    const iterator = started.events;
    await iterator.next();
    await iterator.return(undefined);
    const afterStop = r.store.get(idOf(first))!.messages;
    assert.deepEqual(afterStop.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
    assert.equal(afterStop.at(-1)!.problem?.kind, "stopped");

    const failed = await r.turn({ conversationId: idOf(first), message: "third" });
    assert.equal(failed.at(-1)!.type, "error");
    assert.equal(r.store.get(idOf(first))!.messages.length, 4, "neither the failed answer nor its question is kept");
    const lonely = await r.turn({ message: "a new one that fails" });
    assert.equal(r.store.get(idOf(lonely)), undefined);
    assert.equal(r.store.list().length, 1);
  } finally {
    await r.endpoint.close();
  }
});

test("a Conversation is refused when it has grown too long", async () => {
  const r = await rig([{ chunks: answer("a") }]);
  try {
    const id = idOf(await r.turn({ message: "first" }));
    const refused = startConversationTurn(r.store, r.deps, { conversationId: id, text: CADDYFILE, message: "x".repeat(70_000), pending: null });
    assert.equal(refused.ok, false);
    assert.match((refused as { error: string }).error, /too long/);
  } finally {
    await r.endpoint.close();
  }
});

test("a turn request is checked before anything happens", () => {
  const ok = { conversationId: null, text: "a", message: "hi" };
  assert.equal(checkTurnBody(ok).ok, true);
  assert.equal(checkTurnBody({ ...ok, conversationId: "abc", pending: { messageId: 2, text: "b" } }).ok, true);
  assert.equal(checkTurnBody(null).ok, false);
  assert.equal(checkTurnBody({ ...ok, message: "  " }).ok, false);
  assert.equal(checkTurnBody({ ...ok, text: 5 }).ok, false);
  assert.equal(checkTurnBody({ ...ok, conversationId: 5 }).ok, false);
  assert.equal(checkTurnBody({ ...ok, pending: { messageId: "x", text: "b" } }).ok, false);
});

test("masking with a numbering gives new values new numbers and never reuses one", () => {
  const numbering = { numbers: {} as Record<string, number>, key: (v: string) => `h:${v}` };
  const a = maskCaddyfile(CADDYFILE, undefined, numbering);
  const b = maskCaddyfile(`x.test {\n\theader_up X-Key ${OTHER_SECRET}\n}\n${CADDYFILE}`, undefined, numbering);
  assert.match(a.text, /__FAIRWAY_SECRET_1__/);
  assert.match(b.text, /X-Key __FAIRWAY_SECRET_2__/);
  assert.match(b.text, /Authorization __FAIRWAY_SECRET_1__/);
});

// ---- through the app ----

async function appRig(options: { login: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "ce-conversations-app-"));
  const caddyfile = join(dir, "Caddyfile");
  await writeFile(caddyfile, CADDYFILE);
  const endpoint = await fakeEndpoint([{ chunks: toolCall("c1", edit("app:8080", "app:9090")) }, { chunks: answer("Proposed.") }]);
  const config = loadConfig({
    ADMIN_SOCKET: join(dir, "missing.sock"),
    CADDYFILE_PATH: caddyfile,
    DATA_DIR: join(dir, "data"),
    LOG_DIR: dir,
    WEB_ROOT: dir,
    AI_BASE_URL: endpoint.baseUrl,
    AI_ASSISTANT_MODEL: "model-a",
    ...(options.login && { AUTH_USER: "owner", AUTH_PASSWORD: "correct horse battery" }),
  });
  const shutdown: Array<() => Promise<void>> = [];
  const app = await createApp(config, shutdown);
  let cookie = "";
  if (options.login) {
    const res = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "owner", password: "correct horse battery" }) });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }
  const call = (method: string, path: string, body?: unknown, signedIn = true) =>
    app.request(path, { method, headers: { ...(body !== undefined && { "Content-Type": "application/json" }), ...(cookie && signedIn && { Cookie: cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { call, dir, cleanup: async () => { await Promise.allSettled(shutdown.map((fn) => fn())); await endpoint.close(); } };
}

test("the Conversation endpoints list, read, decide and delete, and need a Session and a login", async () => {
  const r = await appRig({ login: true });
  const noLogin = await appRig({ login: false });
  try {
    const turn = await r.call("POST", "/api/assistant/turn", { conversationId: null, text: CADDYFILE, message: "use 9090" });
    const events = await turn.text();
    const id = /event: conversation\ndata: {"id":"([^"]+)","userMessageId":1,"answerMessageId":2}/.exec(events)?.[1];
    assert.ok(id, events);
    assert.match(events, /event: proposal\ndata: .*"messageId":2/);

    const list = (await (await r.call("GET", "/api/assistant/conversations")).json()) as { conversations: Array<{ id: string; title: string; messages: number }> };
    assert.deepEqual(list.conversations.map((c) => [c.id, c.title, c.messages]), [[id, "use 9090", 2]]);

    const one = (await (await r.call("GET", `/api/assistant/conversations/${id}`)).json()) as { conversation: { messages: Array<{ proposal?: { status: string; text: string } }> } };
    assert.equal(one.conversation.messages[1]!.proposal!.status, "pending");
    assert.match(one.conversation.messages[1]!.proposal!.text, /Authorization __FAIRWAY_SECRET_1__/);
    assert.ok(!JSON.stringify(one).includes(SECRET));

    assert.equal((await r.call("PUT", `/api/assistant/conversations/${id}/messages/2/proposal`, { status: "bogus" })).status, 400);
    assert.equal((await r.call("PUT", `/api/assistant/conversations/${id}/messages/2/proposal`, { status: "rejected" })).status, 200);
    assert.equal((await r.call("PUT", `/api/assistant/conversations/${id}/messages/2/proposal`, { status: "accepted" })).status, 409);
    assert.equal((await r.call("PUT", `/api/assistant/conversations/${id}/messages/9/proposal`, { status: "accepted" })).status, 404);
    const after = (await (await r.call("GET", `/api/assistant/conversations/${id}`)).json()) as { conversation: { messages: Array<{ proposal?: { status: string } }> } };
    assert.equal(after.conversation.messages[1]!.proposal!.status, "rejected");

    const unknown = await r.call("POST", "/api/assistant/turn", { conversationId: "nope", text: CADDYFILE, message: "hi" });
    assert.equal(unknown.status, 404);

    assert.equal((await r.call("GET", "/api/assistant/conversations", undefined, false)).status, 401);
    assert.equal((await r.call("GET", `/api/assistant/conversations/${id}`, undefined, false)).status, 401);
    assert.equal((await r.call("DELETE", `/api/assistant/conversations/${id}`, undefined, false)).status, 401);
    assert.equal((await r.call("PUT", `/api/assistant/conversations/${id}/messages/2/proposal`, { status: "accepted" }, false)).status, 401);
    assert.equal((await noLogin.call("GET", "/api/assistant/conversations")).status, 403);
    assert.equal((await noLogin.call("GET", "/api/assistant/conversations/x")).status, 403);
    assert.equal((await noLogin.call("DELETE", "/api/assistant/conversations/x")).status, 403);
    assert.equal((await noLogin.call("PUT", "/api/assistant/conversations/x/messages/1/proposal", { status: "accepted" })).status, 403);

    assert.equal((await r.call("DELETE", `/api/assistant/conversations/${id}`)).status, 200);
    assert.equal((await r.call("GET", `/api/assistant/conversations/${id}`)).status, 404);
    assert.equal((await r.call("DELETE", `/api/assistant/conversations/${id}`)).status, 404);
  } finally {
    await Promise.all([r.cleanup(), noLogin.cleanup()]);
  }
});
