import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseReviewResult, REPORT_TOOL } from "../src/server/review-result.js";
import { LINES_TOOL, MAX_LINE_CALLS } from "../src/server/review-lines.js";
import { REVIEW_MAX_OUTPUT_TOKENS, REVIEW_MAX_PERIOD_MS, REVIEW_RETENTION_MS, Reviews } from "../src/server/reviews.js";

const HOUR = 3_600_000;
const T0 = Date.UTC(2030, 0, 1, 0, 0, 0); // a made-up day
const NOW = T0 + 24 * HOUR;

const entry = (at: number, status: number, uri: string, client: string) =>
  JSON.stringify({ level: "info", ts: at / 1000, logger: "http.log.access", msg: "handled request", request: { remote_ip: client, method: "GET", host: "app.example.test", uri, headers: { "User-Agent": ["scanner/1"] } }, status, duration: 0.01, size: 1 });

const logging = { logs: { web: { writer: { output: "file", filename: "/var/log/caddy/web.log" } } } };
const servers = {
  srv0: {
    listen: [":443"],
    logs: { logger_names: { "app.example.test": ["web"] } },
    routes: [{ match: [{ host: ["app.example.test"] }], handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "10.9.8.7:4000" }] }] }],
  },
};

const sse = (...chunks: unknown[]) => new Response([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
const toolAnswer = (args: unknown, name = REPORT_TOOL) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }] } }] },
  { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 80 } },
];

const GOOD = {
  summary: "Some probing, all turned away.",
  observations: [{ level: "info", sites: ["app.example.test"], title: "Scanner", explanation: "One client asked for admin files.", evidence: [{ client: "203.0.113.9", path: "/.env", status: 404, count: 2 }] }],
};

let clock = NOW;

async function rig(options: { answer?: () => Response | Promise<Response>; loginRequired?: boolean; model?: string | null; live?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ce-reviews-"));
  await writeFile(join(dir, "web.log"), [entry(T0 + 10 * 60_000, 404, "/.env?token=secret", "203.0.113.9"), entry(T0 + 11 * 60_000, 404, "/admin", "203.0.113.9"), entry(T0 + HOUR, 200, "/", "198.51.100.1")].join("\n") + "\n");
  const requests: Array<{ url: string; authorization: string | null; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, authorization: (init.headers as Record<string, string>).Authorization ?? null, body: JSON.parse(String(init.body)) });
    return (options.answer ?? (() => sse(...toolAnswer(GOOD))))();
  }) as unknown as typeof fetch;
  const file = join(dir, "data", "reviews.json");
  const make = () =>
    new Reviews({
      file,
      settings: { model: () => (options.model === undefined ? "made-up-model" : options.model), effective: () => ({ baseUrl: "http://llm.example.test/v1", apiKey: "sk-made-up" }) },
      loadLive: async () => (options.live === false ? { ok: false, error: "no caddy" } : { ok: true, logging, servers }),
      logDir: dir,
      loginRequired: options.loginRequired ?? true,
      fetchImpl,
      now: () => clock,
    });
  clock = NOW;
  const reviews = make();
  await reviews.load();
  return { dir, file, requests, reviews, make };
}

describe("a Review from digest to stored Observations", () => {
  it("sends the digest and the Site summary, and stores what the model reports", async () => {
    const r = await rig();
    const started = await r.reviews.start();
    assert.ok(started.ok);
    assert.equal(started.review.status, "running");
    await r.reviews.idle();

    const review = r.reviews.get(started.review.id)!;
    assert.equal(review.status, "done");
    assert.equal(review.failure, null);
    assert.equal(review.summary, GOOD.summary);
    assert.deepEqual(review.observations, GOOD.observations);
    assert.deepEqual(review.period, { from: T0, to: NOW });
    assert.equal(review.model, "made-up-model");
    assert.deepEqual(review.usage, { promptTokens: 1200, completionTokens: 80 });
    assert.equal(review.finishedAt, NOW);

    assert.equal(r.requests.length, 1);
    const [request] = r.requests;
    assert.equal(request.url, "http://llm.example.test/v1/chat/completions");
    assert.equal(request.body.model, "made-up-model");
    assert.equal(request.body.max_tokens, REVIEW_MAX_OUTPUT_TOKENS);
    const [system, user] = request.body.messages;
    assert.match(system.content, /written by outsiders/);
    assert.match(system.content, /never instructions/);
    const document = JSON.parse(user.content.slice(user.content.indexOf("{")));
    assert.equal(document.digest.sites[0].site, "app.example.test");
    assert.equal(document.digest.sites[0].totals.requests, 3);
    assert.deepEqual(document.sites[0].hosts, ["app.example.test"]);
    assert.deepEqual(document.sites[0].rules[0].destinations, ["proxy"]);
    assert.ok(!user.content.includes("10.9.8.7"), "no upstream address is sent");
    assert.ok(!user.content.includes("secret"), "no query string is sent");
  });

  it("gives the model a tool that reads lines and the one that carries its answer, and nothing that writes", async () => {
    const r = await rig();
    await r.reviews.start();
    await r.reviews.idle();
    assert.deepEqual(r.requests[0].body.tools.map((t: any) => t.function.name), [LINES_TOOL, REPORT_TOOL]);
  });

  it("accepts no Observations as a result", async () => {
    const r = await rig({ answer: () => sse(...toolAnswer({ summary: "Quiet.", observations: [] })) });
    await r.reviews.start();
    await r.reviews.idle();
    assert.equal(r.reviews.list()[0].status, "done");
    assert.deepEqual(r.reviews.list()[0].observations, []);
  });

  it("keeps Reviews in the data folder across a restart, newest first", async () => {
    const r = await rig();
    await r.reviews.start();
    await r.reviews.idle();
    await r.reviews.start();
    await r.reviews.idle();
    const again = r.make();
    await again.load();
    assert.deepEqual(again.list().map((x) => x.id), [2, 1]);
    assert.equal(again.list()[0].observations.length, 1);
    const next = await again.start();
    assert.ok(next.ok);
    assert.equal(next.review.id, 3);
    await again.idle();
  });

  it("marks a Review that was running when Fairway stopped as failed", async () => {
    const r = await rig();
    await mkdir(join(r.dir, "data"), { recursive: true });
    await writeFile(r.file, JSON.stringify({ version: 1, reviews: [{ id: 4, startedAt: T0, finishedAt: null, period: { from: T0 - 1, to: T0 }, status: "running", failure: null, summary: null, observations: [], coverage: { sites: [], skipped: [] }, model: "m", usage: null }] }));
    const again = r.make();
    await again.load();
    const review = again.get(4)!;
    assert.equal(review.status, "failed");
    assert.match(review.failure ?? "", /stopped/);
    assert.equal(again.running(), false);
    assert.equal(JSON.parse(await readFile(r.file, "utf8")).reviews[0].status, "failed");
  });
});

describe("a Review that fails", () => {
  const failing = async (answer: () => Response | Promise<Response>) => {
    const r = await rig({ answer });
    await r.reviews.start();
    await r.reviews.idle();
    const review = r.reviews.list()[0];
    assert.equal(review.status, "failed");
    assert.deepEqual(review.observations, []);
    return review;
  };

  it("fails when the answer does not fit the structure", async () => {
    const review = await failing(() => sse(...toolAnswer({ summary: "x", observations: [{ level: "catastrophic", sites: [], title: "t", explanation: "e", evidence: [] }] })));
    assert.match(review.failure ?? "", /Observation 1/);
    assert.equal(review.summary, null);
  });

  it("fails when the answer is cut off", async () => {
    const review = await failing(() => sse(...toolAnswer('{"summary": "x", "observations": [{"lev')));
    assert.match(review.failure ?? "", /not complete JSON/);
  });

  it("fails on free text without a tool call", async () => {
    const review = await failing(() => sse({ choices: [{ delta: { content: "All quiet." } }] }));
    assert.match(review.failure ?? "", /did not call the tool/);
  });

  it("fails on a call to some other tool", async () => {
    const review = await failing(() => sse(...toolAnswer(GOOD, "write_file")));
    assert.match(review.failure ?? "", /not expected/);
  });

  it("fails with the endpoint's reason, without the key", async () => {
    const review = await failing(() => new Response("{}", { status: 401 }));
    assert.match(review.failure ?? "", /refused the key/);
    assert.ok(!(review.failure ?? "").includes("sk-made-up"));
  });

  it("fails when no Site has an Access log, and still says which were skipped", async () => {
    const r = await rig();
    await writeFile(join(r.dir, "web.log"), "");
    const again = new Reviews({ file: r.file, settings: { model: () => "m", effective: () => ({ baseUrl: "http://llm.example.test/v1", apiKey: null }) }, loadLive: async () => ({ ok: true, logging: {}, servers }), logDir: r.dir, loginRequired: true, fetchImpl: (async () => assert.fail("no model call")) as unknown as typeof fetch, now: () => NOW });
    await again.start();
    await again.idle();
    const review = again.list()[0];
    assert.equal(review.status, "failed");
    assert.match(review.failure ?? "", /No Site has an Access log/);
    assert.equal(review.coverage.skipped.length, 1);
  });

  it("fails when Caddy cannot be read", async () => {
    const r = await rig({ live: false });
    await r.reviews.start();
    await r.reviews.idle();
    assert.match(r.reviews.list()[0].failure ?? "", /running configuration/);
  });
});

describe("starting a Review", () => {
  it("refuses a second one while one runs, and allows one after it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const r = await rig({ answer: async () => (await gate, sse(...toolAnswer(GOOD))) });
    const first = await r.reviews.start();
    assert.ok(first.ok);
    assert.equal(r.reviews.running(), true);
    const second = await r.reviews.start();
    assert.deepEqual(second, { ok: false, status: 409, error: "A Review is already running." });
    release();
    await r.reviews.idle();
    assert.equal(r.reviews.running(), false);
    assert.ok((await r.reviews.start()).ok);
    await r.reviews.idle();
    assert.equal(r.reviews.list().length, 2);
  });

  it("refuses without a login and without a Reviews model", async () => {
    const open = await rig({ loginRequired: false });
    const noLogin = await open.reviews.start();
    assert.ok(!noLogin.ok && noLogin.status === 403);
    const bare = await rig({ model: null });
    const noModel = await bare.reviews.start();
    assert.ok(!noModel.ok && noModel.status === 400);
    assert.equal(open.reviews.list().length + bare.reviews.list().length, 0);
    assert.equal(open.requests.length + bare.requests.length, 0);
  });
});

describe("the structure of an answer", () => {
  const observation = { level: "notable", sites: ["a.example.test"], title: "t", explanation: "e", evidence: [{ count: 3 }] };
  const check = (value: unknown) => parseReviewResult(JSON.stringify(value)).ok;

  it("accepts every level and partial evidence", () => {
    for (const level of ["info", "notable", "urgent"]) assert.ok(check({ summary: "s", observations: [{ ...observation, level }] }));
  });

  it("rejects what does not fit", () => {
    assert.ok(!check([]));
    assert.ok(!check({ summary: "s" }));
    assert.ok(!check({ summary: "", observations: [] }));
    assert.ok(!check({ summary: "s", observations: [], extra: 1 }));
    assert.ok(!check({ summary: "s", observations: [{ ...observation, extra: 1 }] }));
    assert.ok(!check({ summary: "s", observations: [{ ...observation, sites: "a.example.test" }] }));
    assert.ok(!check({ summary: "s", observations: [{ ...observation, evidence: [{}] }] }));
    assert.ok(!check({ summary: "s", observations: [{ ...observation, evidence: [{ status: 99 }] }] }));
    assert.ok(!check({ summary: "s", observations: [{ ...observation, evidence: [{ count: -1 }] }] }));
    assert.ok(!check({ summary: "s", observations: [{ ...observation, evidence: [{ client: 5 }] }] }));
    assert.ok(!check({ summary: "s", observations: [{ ...observation, title: "x".repeat(300) }] }));
  });
});

describe("a Review that asks for log lines", () => {
  const linesAnswer = (args: unknown, id = "call_l") => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: LINES_TOOL, arguments: JSON.stringify(args) } }] } }] }, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } });
  const script = (...answers: Array<() => Response>) => {
    let n = 0;
    return () => answers[Math.min(n++, answers.length - 1)]();
  };
  const toolMessages = (request: any) => request.body.messages.filter((m: any) => m.role === "tool");

  it("sends the redacted rows back, records the request and finishes with the report", async () => {
    const r = await rig({ answer: script(() => linesAnswer({ host: "app.example.test", client: "203.0.113.9" }), () => sse(...toolAnswer(GOOD))) });
    await r.reviews.start();
    await r.reviews.idle();
    const review = r.reviews.list()[0];
    assert.equal(review.status, "done");
    assert.equal(r.requests.length, 2);
    const [message] = toolMessages(r.requests[1]);
    const result = JSON.parse(message.content);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].path, "/admin");
    assert.equal(result.rows[1].path, "/.env");
    assert.ok(!message.content.includes("secret"), "no query string");
    assert.deepEqual(review.usage, { promptTokens: 1300, completionTokens: 90 });
    assert.equal(review.linesRequested.length, 1);
    assert.equal(review.linesRequested[0].rows, 2);
    assert.equal(review.linesRequested[0].request.client, "203.0.113.9");
    assert.ok(!JSON.stringify(review.linesRequested).includes("/admin"), "the rows are not stored");
  });

  it("answers a bad call with the reason and does not fail the Review", async () => {
    const r = await rig({ answer: script(() => linesAnswer({ host: "other.example.test" }), () => sse(...toolAnswer(GOOD))) });
    await r.reviews.start();
    await r.reviews.idle();
    const review = r.reviews.list()[0];
    assert.equal(review.status, "done");
    assert.match(JSON.parse(toolMessages(r.requests[1])[0].content).error, /not a host/);
    assert.deepEqual(review.linesRequested, []);
  });

  it("tells the model when the call limit is reached, then fails it if it goes on", async () => {
    const r = await rig({ answer: () => linesAnswer({ host: "app.example.test" }) });
    await r.reviews.start();
    await r.reviews.idle();
    const review = r.reviews.list()[0];
    assert.equal(review.status, "failed");
    assert.match(review.failure ?? "", /limit/);
    assert.equal(review.linesRequested.length, MAX_LINE_CALLS);
    assert.equal(r.requests.length, MAX_LINE_CALLS + 2);
    assert.match(JSON.parse(toolMessages(r.requests.at(-1)!).at(-1).content).error, /report tool/);
  });

  it("lets the model finish after the limit message", async () => {
    const answers = Array.from({ length: MAX_LINE_CALLS + 1 }, () => () => linesAnswer({ host: "app.example.test", limit: 1 }));
    const r = await rig({ answer: script(...answers, () => sse(...toolAnswer(GOOD))) });
    await r.reviews.start();
    await r.reviews.idle();
    assert.equal(r.reviews.list()[0].status, "done");
  });

  it("fails when the report is mixed with a lines call", async () => {
    const mixed = () => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: LINES_TOOL, arguments: "{}" } }, { index: 1, id: "b", function: { name: REPORT_TOOL, arguments: JSON.stringify(GOOD) } }] } }] });
    const r = await rig({ answer: mixed });
    await r.reviews.start();
    await r.reviews.idle();
    assert.equal(r.reviews.list()[0].status, "failed");
  });

  it("mentions the tool in the prompt", async () => {
    const r = await rig();
    await r.reviews.start();
    await r.reviews.idle();
    assert.match(r.requests[0].body.messages[0].content, new RegExp(LINES_TOOL));
  });
});

const DAY = 24 * HOUR;

describe("the period of a Review", () => {
  const run = async (r: Awaited<ReturnType<typeof rig>>) => {
    const started = await r.reviews.start();
    assert.ok(started.ok);
    await r.reviews.idle();
    return r.reviews.get(started.review.id)!;
  };

  it("is the last 24 hours when there is no earlier Review", async () => {
    const r = await rig();
    const review = await run(r);
    assert.deepEqual(review.period, { from: NOW - DAY, to: NOW });
    assert.deepEqual(review.coverage.gaps, []);
  });

  it("starts where the last done Review ended, so nothing is skipped or read twice", async () => {
    const r = await rig();
    const first = await run(r);
    clock = NOW + 5 * HOUR;
    const second = await run(r);
    assert.deepEqual(second.period, { from: first.period.to, to: NOW + 5 * HOUR });
  });

  it("is not moved forward by a failed Review", async () => {
    const r = await rig();
    const first = await run(r);
    clock = NOW + 3 * HOUR;
    const bad = new Reviews({ file: r.file, settings: { model: () => "made-up-model", effective: () => ({ baseUrl: "http://llm.example.test/v1", apiKey: null }) }, loadLive: async () => ({ ok: false, error: "no caddy" }), logDir: r.dir, loginRequired: true, now: () => clock });
    await bad.load();
    assert.ok((await bad.start()).ok);
    await bad.idle();
    assert.equal(bad.list()[0].status, "failed");
    clock = NOW + 6 * HOUR;
    const next = new Reviews({ file: r.file, settings: { model: () => "made-up-model", effective: () => ({ baseUrl: "http://llm.example.test/v1", apiKey: null }) }, loadLive: async () => ({ ok: false, error: "no caddy" }), logDir: r.dir, loginRequired: true, now: () => clock });
    await next.load();
    const started = await next.start();
    assert.ok(started.ok);
    assert.deepEqual(started.review.period, { from: first.period.to, to: NOW + 6 * HOUR });
    await next.idle();
  });

  it("is capped at 31 days and records the part before as a time Fairway ran no Review", async () => {
    const r = await rig();
    const first = await run(r);
    clock = first.period.to + 40 * DAY;
    const late = await run(r);
    assert.deepEqual(late.period, { from: clock - REVIEW_MAX_PERIOD_MS, to: clock });
    assert.deepEqual(late.coverage.gaps, [{ from: first.period.to, to: clock - REVIEW_MAX_PERIOD_MS, reason: "no-review" }]);
  });
});

describe("Observations reported last time", () => {
  const ONGOING = { ...GOOD, observations: [{ ...GOOD.observations[0], ongoing: true }] };

  it("are given to the model without their evidence", async () => {
    const r = await rig();
    await r.reviews.start();
    await r.reviews.idle();
    assert.equal(JSON.parse(r.requests[0].body.messages[1].content.split("\n\n")[1]).reportedLastTime.length, 0);
    clock = NOW + DAY;
    await r.reviews.start();
    await r.reviews.idle();
    const user = r.requests[1].body.messages[1].content as string;
    const document = JSON.parse(user.slice(user.indexOf("{")));
    assert.deepEqual(document.reportedLastTime, [{ level: "info", sites: ["app.example.test"], title: "Scanner", explanation: "One client asked for admin files." }]);
    assert.ok(!JSON.stringify(document.reportedLastTime).includes("203.0.113.9"));
    assert.match(r.requests[1].body.messages[0].content, /ongoing/);
  });

  it("can be marked ongoing, and Reviews stored without the field still load", async () => {
    const r = await rig({ answer: () => sse(...toolAnswer(ONGOING)) });
    await r.reviews.start();
    await r.reviews.idle();
    assert.equal(r.reviews.list()[0].observations[0].ongoing, true);
    assert.equal(parseReviewResult(JSON.stringify(GOOD)).ok, true);
    assert.equal(parseReviewResult(JSON.stringify({ ...GOOD, observations: [{ ...GOOD.observations[0], ongoing: "yes" }] })).ok, false);
    await mkdir(join(r.dir, "data"), { recursive: true });
    await writeFile(r.file, JSON.stringify({ version: 1, reviews: [{ id: 1, startedAt: NOW, finishedAt: NOW, period: { from: NOW - DAY, to: NOW }, status: "done", failure: null, summary: "s", observations: GOOD.observations, coverage: { sites: [], skipped: [] }, model: "m", usage: null }] }));
    const again = r.make();
    await again.load();
    assert.equal(again.get(1)?.observations[0].ongoing, undefined);
  });
});

describe("how long Reviews are kept", () => {
  it("removes Reviews that started more than 30 days ago, on load and when a Review finishes", async () => {
    const r = await rig();
    await mkdir(join(r.dir, "data"), { recursive: true });
    const stored = (id: number, startedAt: number) => ({ id, startedAt, finishedAt: startedAt, period: { from: startedAt - DAY, to: startedAt }, status: "failed", failure: "x", summary: null, observations: [], coverage: { sites: [], skipped: [] }, model: "m", usage: null });
    await writeFile(r.file, JSON.stringify({ version: 1, reviews: [stored(1, NOW - REVIEW_RETENTION_MS - HOUR), stored(2, NOW - REVIEW_RETENTION_MS + HOUR)] }));
    const again = r.make();
    await again.load();
    assert.deepEqual(again.list().map((x) => x.id), [2]);
    clock = NOW + 2 * HOUR; // review 2 is now past 30 days
    await again.start();
    await again.idle();
    assert.deepEqual(again.list().map((x) => x.id), [3]);
    assert.deepEqual(JSON.parse(await readFile(r.file, "utf8")).reviews.map((x: { id: number }) => x.id), [3]);
  });
});
