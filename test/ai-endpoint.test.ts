import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { test } from "node:test";
import { chat, listModels, normalizeBaseUrl, testConnection, testToolCalling, type ChatEvent, type ChatRequest } from "../src/server/ai-endpoint.js";

const KEY = "sk-test-made-up-key";

async function fake(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return { baseUrl, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

test("addresses are normalised and only http(s) without a login is accepted", () => {
  assert.equal(normalizeBaseUrl(" https://a.example.test/v1/ "), "https://a.example.test/v1");
  assert.equal(normalizeBaseUrl("http://localhost:11434/v1"), "http://localhost:11434/v1");
  for (const bad of ["", "a.example.test", "ftp://a.example.test", "https://u:p@a.example.test", "https://a.example.test?x=1"]) assert.equal(normalizeBaseUrl(bad), null, bad);
});

test("a model list with the right key is a working connection, asked for with the key", async () => {
  let seen: { url?: string; authorization?: string } = {};
  const f = await fake((req, res) => {
    seen = { url: req.url, authorization: req.headers.authorization };
    json(res, 200, { object: "list", data: [{ id: "model-a" }, { id: "model-b" }] });
  });
  try {
    assert.deepEqual(await testConnection({ baseUrl: f.baseUrl, apiKey: KEY }), { ok: true, models: 2 });
    assert.deepEqual(seen, { url: "/v1/models", authorization: `Bearer ${KEY}` });
  } finally {
    await f.close();
  }
});

test("without a key no Authorization header is sent", async () => {
  let auth: string | undefined = "unset";
  const f = await fake((req, res) => {
    auth = req.headers.authorization;
    json(res, 200, { data: [] });
  });
  try {
    assert.equal((await testConnection({ baseUrl: f.baseUrl, apiKey: null })).ok, true);
    assert.equal(auth, undefined);
  } finally {
    await f.close();
  }
});

test("a refused key is reported as such, and the key is not in the reason", async () => {
  const f = await fake((req, res) => json(res, 401, { error: { message: `bad key ${req.headers.authorization}` } }));
  try {
    const result = await testConnection({ baseUrl: f.baseUrl, apiKey: KEY });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "key_refused");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY));
  } finally {
    await f.close();
  }
});

test("an answer that is not a model list is not an OpenAI-compatible endpoint", async () => {
  for (const respond of [(res: ServerResponse) => json(res, 200, "<html>hello</html>"), (res: ServerResponse) => json(res, 200, { models: [] }), (res: ServerResponse) => json(res, 404, {}), (res: ServerResponse) => json(res, 500, {})]) {
    const f = await fake((_req, res) => respond(res));
    try {
      const result = await testConnection({ baseUrl: f.baseUrl, apiKey: KEY });
      assert.equal(!result.ok && result.reason, "not_compatible");
    } finally {
      await f.close();
    }
  }
});

test("a redirect is not followed, so the key stays with the address given", async () => {
  let elsewhere = 0;
  const other = await fake((_req, res) => {
    elsewhere++;
    json(res, 200, { data: [] });
  });
  const f = await fake((_req, res) => {
    res.writeHead(302, { Location: `${other.baseUrl}/models` });
    res.end();
  });
  try {
    const result = await testConnection({ baseUrl: f.baseUrl, apiKey: KEY });
    assert.equal(!result.ok && result.reason, "not_compatible");
    assert.equal(elsewhere, 0);
  } finally {
    await f.close();
    await other.close();
  }
});

test("an endpoint nobody listens on is unreachable, and the reason does not carry the key", async () => {
  const f = await fake((_req, res) => json(res, 200, {}));
  await f.close();
  const result = await testConnection({ baseUrl: f.baseUrl, apiKey: KEY });
  assert.equal(!result.ok && result.reason, "unreachable");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY));
});

test("an endpoint that never answers times out as unreachable", async () => {
  const result = await testConnection({ baseUrl: "http://127.0.0.1:1/v1", apiKey: null }, (async () => {
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  }) as unknown as typeof fetch);
  assert.deepEqual(result, { ok: false, reason: "unreachable", error: "The endpoint did not answer in time." });
});

// ---- model list ----

test("the model list is the endpoint's ids, sorted and without repeats", async () => {
  const f = await fake((_req, res) => json(res, 200, { data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-b" }, {}, "x"] }));
  try {
    assert.deepEqual(await listModels({ baseUrl: f.baseUrl, apiKey: KEY }), { ok: true, models: ["model-a", "model-b"] });
  } finally {
    await f.close();
  }
});

test("an endpoint without a model list gives a reason, not a list", async () => {
  const f = await fake((_req, res) => json(res, 404, {}));
  try {
    const result = await listModels({ baseUrl: f.baseUrl, apiKey: null });
    assert.equal(!result.ok && result.reason, "not_compatible");
  } finally {
    await f.close();
  }
});

// ---- chat ----

const sse = (res: ServerResponse, chunks: unknown[], done = true) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const chunk of chunks) res.write(`data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`);
  if (done) res.write("data: [DONE]\n\n");
  res.end();
};
const delta = (d: Record<string, unknown>) => ({ choices: [{ index: 0, delta: d }] });
const collect = async (events: AsyncGenerator<ChatEvent>) => {
  const all: ChatEvent[] = [];
  for await (const e of events) all.push(e);
  return all;
};
const ask: ChatRequest = { model: "model-a", messages: [{ role: "user", content: "hi" }] };

test("the chat call sends the OpenAI format with streaming and usage asked for, and the key", async () => {
  let seen: { url?: string; authorization?: string; body?: any } = {};
  const f = await fake((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) };
      sse(res, [delta({ content: "ok" })]);
    });
  });
  try {
    await collect(
      chat(
        { baseUrl: f.baseUrl, apiKey: KEY },
        {
          model: "model-a",
          messages: [
            { role: "system", content: "be brief" },
            { role: "user", content: "hi" },
            { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "look", arguments: "{}" }] },
            { role: "tool", toolCallId: "c1", content: "result" },
          ],
          tools: [{ name: "look", description: "Looks.", parameters: { type: "object", properties: {} } }],
        },
      ),
    );
    assert.equal(seen.url, "/v1/chat/completions");
    assert.equal(seen.authorization, `Bearer ${KEY}`);
    assert.equal(seen.body.stream, true);
    assert.deepEqual(seen.body.stream_options, { include_usage: true });
    assert.deepEqual(seen.body.tools, [{ type: "function", function: { name: "look", description: "Looks.", parameters: { type: "object", properties: {} } } }]);
    assert.deepEqual(seen.body.messages[2], { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "look", arguments: "{}" } }] });
    assert.deepEqual(seen.body.messages[3], { role: "tool", tool_call_id: "c1", content: "result" });
  } finally {
    await f.close();
  }
});

test("a token cap is sent as max_tokens and an answer cut off by it is reported", async () => {
  let sent: { max_tokens?: number } = {};
  const f = await fake((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      sent = JSON.parse(raw);
      sse(res, [delta({ content: "part" }), { choices: [{ index: 0, delta: {}, finish_reason: "length" }] }]);
    });
  });
  try {
    const events = await collect(chat({ baseUrl: f.baseUrl, apiKey: null }, { ...ask, maxTokens: 50 }));
    assert.equal(sent.max_tokens, 50);
    assert.deepEqual(events, [{ type: "text", delta: "part" }, { type: "truncated" }]);
  } finally {
    await f.close();
  }
});

test("streamed text arrives as deltas, tool calls are assembled from fragments, and usage is reported", async () => {
  const f = await fake((_req, res) =>
    sse(res, [
      delta({ role: "assistant", content: "Hel" }),
      delta({ content: "lo" }),
      delta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "look", arguments: "" } }] }),
      delta({ tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "peek", arguments: "{}" } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"host":' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '"a.example.test"}' } }] }),
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
    ]),
  );
  try {
    assert.deepEqual(await collect(chat({ baseUrl: f.baseUrl, apiKey: null }, ask)), [
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      { type: "tool_call", call: { id: "call_1", name: "look", arguments: '{"host":"a.example.test"}' } },
      { type: "tool_call", call: { id: "call_2", name: "peek", arguments: "{}" } },
      { type: "usage", usage: { promptTokens: 12, completionTokens: 5 } },
    ]);
  } finally {
    await f.close();
  }
});

test("a stream split in the middle of a line and without [DONE] still comes out whole", async () => {
  const f = await fake((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const line = `data: ${JSON.stringify(delta({ content: "split" }))}\n\n`;
    res.write(line.slice(0, 15));
    setTimeout(() => res.end(line.slice(15)), 20);
  });
  try {
    assert.deepEqual(await collect(chat({ baseUrl: f.baseUrl, apiKey: null }, ask)), [{ type: "text", delta: "split" }]);
  } finally {
    await f.close();
  }
});

test("endpoint errors become readable reasons written by Fairway, without the key or the endpoint's words", async () => {
  const cases: Array<[number, string]> = [[401, "key_refused"], [404, "model_unavailable"], [429, "rate_limited"], [400, "refused"], [500, "refused"]];
  for (const [status, reason] of cases) {
    const f = await fake((req, res) => json(res, status, { error: { message: `secret words ${req.headers.authorization}` } }));
    try {
      const events = await collect(chat({ baseUrl: f.baseUrl, apiKey: KEY }, ask));
      assert.equal(events.length, 1);
      assert.equal(events[0].type === "error" && events[0].reason, reason, String(status));
      assert.doesNotMatch(JSON.stringify(events), new RegExp(`${KEY}|secret words`));
    } finally {
      await f.close();
    }
  }
});

test("an unreachable endpoint, an error inside the stream and a non-stream answer are each one error event", async () => {
  const gone = await fake((_req, res) => json(res, 200, {}));
  await gone.close();
  assert.equal((await collect(chat({ baseUrl: gone.baseUrl, apiKey: KEY }, ask)))[0].type === "error", true);

  const broken = await fake((_req, res) => sse(res, [delta({ content: "a" }), { error: { message: `boom ${KEY}` } }], false));
  try {
    const events = await collect(chat({ baseUrl: broken.baseUrl, apiKey: KEY }, ask));
    assert.deepEqual(events.map((e) => e.type), ["text", "error"]);
    assert.doesNotMatch(JSON.stringify(events), /boom/);
  } finally {
    await broken.close();
  }

  const html = await fake((_req, res) => sse(res, ["<html>"]));
  try {
    const events = await collect(chat({ baseUrl: html.baseUrl, apiKey: null }, ask));
    assert.equal(events[0].type === "error" && events[0].reason, "not_compatible");
  } finally {
    await html.close();
  }
});

test("an abort signal stops the call with an aborted error", async () => {
  const f = await fake((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(delta({ content: "first" }))}\n\n`);
  });
  try {
    const controller = new AbortController();
    const events: ChatEvent[] = [];
    for await (const e of chat({ baseUrl: f.baseUrl, apiKey: null }, { ...ask, signal: controller.signal })) {
      events.push(e);
      if (e.type === "text") controller.abort();
    }
    assert.deepEqual(events.map((e) => e.type), ["text", "error"]);
    assert.equal(events[1].type === "error" && events[1].reason, "aborted");
  } finally {
    await f.close();
  }
});

// ---- the tool test ----

test("a model that calls the tool passes the test, and the request carries one tool", async () => {
  let body: any;
  const f = await fake((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      body = JSON.parse(raw);
      sse(res, [delta({ tool_calls: [{ index: 0, id: "c", function: { name: "report_ready", arguments: '{"ready":true}' } }] })]);
    });
  });
  try {
    assert.deepEqual(await testToolCalling({ baseUrl: f.baseUrl, apiKey: KEY }, "model-a"), { ok: true });
    assert.equal(body.model, "model-a");
    assert.equal(body.tools.length, 1);
  } finally {
    await f.close();
  }
});

test("a model that answers in text is reported as lacking tool calling", async () => {
  const f = await fake((_req, res) => sse(res, [delta({ content: "I cannot do that." })]));
  try {
    const result = await testToolCalling({ baseUrl: f.baseUrl, apiKey: KEY }, "model-a");
    assert.equal(!result.ok && result.reason, "no_tool_call");
    assert.match(!result.ok ? result.error : "", /tool calling/);
  } finally {
    await f.close();
  }
});

test("an endpoint that rejects the tool request fails the test with a reason that has no key in it", async () => {
  const f = await fake((req, res) => json(res, 400, { error: { message: `no tools ${req.headers.authorization}` } }));
  try {
    const result = await testToolCalling({ baseUrl: f.baseUrl, apiKey: KEY }, "model-a");
    assert.equal(!result.ok && result.reason, "refused");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${KEY}|no tools`));
  } finally {
    await f.close();
  }
});
