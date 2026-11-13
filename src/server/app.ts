import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAuth, loadSecret, parseTrustProxy } from "./auth.js";
import { AlertSettings, type Patch, type RouteMap, type TopicPatch } from "./alert-settings.js";
import { listModels, testConnection, testToolCalling } from "./ai-endpoint.js";
import { checkTurnBody, startConversationTurn } from "./conversation-turn.js";
import { Conversations, placeholderKey } from "./conversations.js";
import { AI_TASKS, AiSettings, type AiPatch, type AiTask } from "./ai-settings.js";
import { parseNtfyUrls } from "./alerts.js";
import { CaddyAdmin } from "./caddy-admin.js";
import type { Config } from "./config.js";
import { DeployError, Deployer } from "./deploy.js";
import { HostCheck } from "./host-check.js";
import { EventTracker, type SubjectKind } from "./events.js";
import { formatCaddyfile } from "./format.js";
import { bareHost, matchesFilter, parseHostLines, parseHostLogFilter, readHostLog, resolutionKey, resolveHostLogFile } from "./host-logs.js";
import { buildLogDigest } from "./log-digest.js";
import { alertOnFinished } from "./review-alert.js";
import { Reviews } from "./reviews.js";
import { ReviewSchedule } from "./review-schedule.js";
import { LogFollower, tailLines } from "./logs.js";
import { MetricsTracker, WINDOWS_MS } from "./metrics.js";
import { buildRouteMap } from "./route-map.js";
import { summarizeRoutes } from "./routes.js";
import { Store } from "./store.js";
import { lastIssuanceError } from "./issuance.js";
import { summarizeTls } from "./tls.js";
import { probeEligibility, TlsProber } from "./tls-probe.js";
import { TlsSweep } from "./tls-sweep.js";
import { upstreamKey, Watcher } from "./watcher.js";

/** How often a host log stream re-reads the config, and how often it sends a keep-alive. */
const RESOLVE_CHECK_MS = 3_000;
const PING_MS = 15_000;

/** `onShutdown` collects work to finish before the process exits. */
export async function createApp(config: Config, onShutdown: Array<() => Promise<void>> = []) {
  const admin = new CaddyAdmin(config.adminSocket);
  const metrics = new MetricsTracker(admin, undefined, join(config.dataDir, "metrics.json"));
  await metrics.load();
  metrics.start();
  onShutdown.push(() => metrics.save());
  // The environment gives the alert settings their defaults; what the Owner changes in the interface wins.
  const alertSettings = new AlertSettings(
    { ntfyUrls: parseNtfyUrls(config.ntfyUrl), ntfyToken: config.ntfyToken, publicUrl: config.publicUrl },
    join(config.dataDir, "alert-settings.json"),
  );
  await alertSettings.load();
  // The model endpoint follows the same rule: the environment's values, overridden by what the Owner saved.
  const aiSettings = new AiSettings({ baseUrl: config.aiBaseUrl, apiKey: config.aiApiKey, assistantModel: config.aiAssistantModel, reviewModel: config.aiReviewModel, reviewInterval: config.aiReviewInterval }, join(config.dataDir, "ai-settings.json"));
  await aiSettings.load();
  const events = new EventTracker({ file: join(config.dataDir, "events.json") });
  // Which hosts use which upstream, so an upstream's Alert can be left out when none of its hosts want one.
  let routeMap: RouteMap = { upstreamHosts: new Map() };
  const refreshRouteMap = async () => {
    const servers = await admin.liveServers();
    if (servers.ok) routeMap = buildRouteMap(servers.servers); // otherwise keep what we knew
  };
  await refreshRouteMap();
  setInterval(() => void refreshRouteMap(), 60_000).unref(); // a Deploy refreshes it at once
  const applyAlertSettings = () => {
    const { publicUrl, policy } = alertSettings.effective();
    events.configure({ sender: alertSettings.sender(), publicUrl, policy, scope: alertSettings.scope(() => routeMap) });
  };
  applyAlertSettings();
  alertSettings.onChange(applyAlertSettings);
  await events.load();
  events.start();
  onShutdown.push(() => events.save());
  const watcher = new Watcher(events, {
    ping: () => admin.ping(),
    metricsText: () => admin.metricsText().catch(() => null),
  });
  watcher.start();
  const store = new Store(config.dataDir, config.maxRevisions);
  await store.init();
  const deployer = new Deployer(config.caddyfilePath, admin, store, events);
  await deployer.ensureOriginal();

  const auth = await createAuth({
    user: config.authUser ?? undefined,
    password: config.authPassword ?? undefined,
    passwordHash: config.authPasswordHash ?? undefined,
    dataDir: config.dataDir,
    trustProxy: parseTrustProxy(config.trustProxy),
  });
  if (!auth.enabled) console.warn("fairway: no login configured (AUTH_USER and AUTH_PASSWORD), anyone who can reach this page can change your proxy");

  const app = new Hono();
  // Conversations with the Assistant need a login, so the key behind their placeholder numbers can come from its secret.
  const conversations = new Conversations({ file: join(config.dataDir, "conversations.json"), key: placeholderKey(auth.enabled ? await loadSecret(config.dataDir) : Buffer.alloc(32)) });
  await conversations.load();
  onShutdown.push(() => conversations.save());
  const reviews = new Reviews({
    file: join(config.dataDir, "reviews.json"),
    settings: aiSettings,
    loadLive: () => liveLogConfig(),
    logDir: config.logDir,
    loginRequired: auth.enabled,
    // A Review that found something serious is an Event like any other, and the Alert follows from it (ADR 0006).
    onFinished: alertOnFinished({ level: () => alertSettings.effective().policy.reviewLevel, record: (found) => events.recordReviewFound(found), recordFailing: (failing) => events.recordReviewFailing(failing) }),
  });
  await reviews.load();
  onShutdown.push(() => reviews.save());
  const reviewSchedule = new ReviewSchedule({ reviews, settings: aiSettings, loginRequired: auth.enabled });
  reviewSchedule.start();
  onShutdown.push(async () => reviewSchedule.stop());
  const logPath = join(config.logDir, config.logFile);

  // The login routes stay open; everything else under /api needs a Session once login is on.
  app.route("/api/auth", auth.routes);
  app.use("/api/*", auth.guard);

  app.get("/api/status", async (c) =>
    c.json({
      caddyReachable: await admin.ping(),
      auth: auth.enabled ? { mode: "login" } : { mode: "none" },
    }),
  );

  app.get("/api/caddyfile", async (c) => c.json(await deployer.current()));

  app.post("/api/validate", async (c) => {
    const { text } = await c.req.json<{ text: string }>();
    return c.json(await deployer.validate(text));
  });

  // With `text`, shows what that Caddyfile would route; without, what Caddy is running now.
  app.get("/api/metrics", (c) => {
    const seconds = Number(c.req.query("window"));
    const windowMs = WINDOWS_MS.find((ms) => ms === seconds * 1000) ?? WINDOWS_MS[0];
    return c.json(metrics.snapshot(windowMs));
  });

  app.post("/api/routes", async (c) => {
    const { text } = await c.req.json<{ text?: string }>().catch(() => ({ text: undefined }));
    const result = text === undefined ? await admin.liveServers() : await admin.adaptedServers(text);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 502);
    return c.json({ ok: true, source: text === undefined ? "running" : "editor", sites: summarizeRoutes(result.servers) });
  });

  app.get("/api/tls", async (c) => {
    const servers = await admin.liveServers();
    if (!servers.ok) return c.json({ ok: false, error: servers.error }, 502);
    const tls = await admin.liveTls();
    // Caddy answers 404-ish for a missing tls app; that just means no policies or manual certificates.
    return c.json({ ok: true, sites: summarizeTls(servers.servers, tls.ok ? tls.tls : {}) });
  });

  // The live config's HTTP servers and logging section, which together say where a host logs to.
  const liveLogConfig = async () => {
    const servers = await admin.liveServers();
    if (!servers.ok) return { ok: false as const, error: servers.error };
    const logging = await admin.liveLogging();
    if (!logging.ok) return { ok: false as const, error: logging.error };
    return { ok: true as const, servers: servers.servers, logging: logging.logging };
  };

  // Which file a host logs to is read from the running config on every request; nothing is cached.
  app.get("/api/host-logs", async (c) => {
    const host = c.req.query("host")?.trim();
    if (!host) return c.json({ ok: false, error: "Missing host" }, 400);
    const parsed = parseHostLogFilter((name) => c.req.query(name));
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    const live = await liveLogConfig();
    if (!live.ok) return c.json({ ok: false, error: live.error }, 502);
    return c.json(await readHostLog({ logging: live.logging, servers: live.servers, logDir: config.logDir, host, limit: 200, filter: parsed.filter }));
  });

  // A digest of the Access log of one Site (`host`, any of its hosts) or of every Site, over `from` to `to`
  // (epoch ms; the last 24 hours by default, at most 31 days). The whole period is read, so it can take a moment.
  app.get("/api/log-digest", async (c) => {
    const to = c.req.query("to") ? Number(c.req.query("to")) : Date.now();
    const from = c.req.query("from") ? Number(c.req.query("from")) : to - 24 * 3_600_000;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return c.json({ ok: false, error: "Invalid period" }, 400);
    if (to - from > 31 * 24 * 3_600_000) return c.json({ ok: false, error: "The period is longer than 31 days" }, 400);
    const live = await liveLogConfig();
    if (!live.ok) return c.json({ ok: false, error: live.error }, 502);
    let sites = summarizeRoutes(live.servers).map((site) => ({ hosts: site.hosts }));
    const host = c.req.query("host")?.trim();
    if (host) {
      const wanted = bareHost(host);
      sites = sites.filter((site) => site.hosts.some((h) => bareHost(h) === wanted));
      if (sites.length === 0) return c.json({ ok: false, error: "No such site" }, 404);
    }
    const digest = await buildLogDigest({ logging: live.logging, servers: live.servers, logDir: config.logDir, sites, from, to });
    return c.json({ ok: true, digest });
  });

  // Live tail of one host. Data events carry a JSON array of parsed lines for the host; the `end` event
  // means the host's file or the config changed (or can no longer be followed) and the client should reload.
  app.get("/api/host-logs/stream", (c) => {
    const host = c.req.query("host")?.trim();
    if (!host) return c.json({ ok: false, error: "Missing host" }, 400);
    const parsed = parseHostLogFilter((name) => c.req.query(name));
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    const filter = parsed.filter;
    const resolve = async () => {
      const live = await liveLogConfig();
      return live.ok ? resolveHostLogFile({ logging: live.logging, servers: live.servers, logDir: config.logDir, host }) : null;
    };
    return streamSSE(c, async (stream) => {
      const first = await resolve();
      if (!first?.ok) {
        await stream.writeSSE({ event: "end", data: "" });
        return;
      }
      const key = resolutionKey(first);
      const follower = new LogFollower(first.path, (raw) => {
        const lines = parseHostLines(raw, host).filter((line) => matchesFilter(line, filter));
        if (lines.length > 0) void stream.writeSSE({ data: JSON.stringify(lines) });
      });
      await follower.start();
      stream.onAbort(() => follower.stop());
      let sincePing = 0;
      try {
        while (!stream.aborted) {
          await stream.sleep(RESOLVE_CHECK_MS);
          if (stream.aborted) break;
          const now = await resolve();
          if (!now || resolutionKey(now) !== key) {
            await stream.writeSSE({ event: "end", data: "" });
            break;
          }
          sincePing += RESOLVE_CHECK_MS;
          if (sincePing >= PING_MS) {
            sincePing = 0;
            await stream.writeSSE({ event: "ping", data: "" });
          }
        }
      } finally {
        follower.stop();
      }
    });
  });

  app.get("/api/upstreams", async (c) => {
    const result = await admin.upstreams();
    return result.ok ? c.json(result) : c.json(result, 502);
  });

  const listProbeHosts = async () => {
    const servers = await admin.liveServers();
    if (!servers.ok) throw new Error(servers.error);
    const tls = await admin.liveTls();
    return summarizeTls(servers.servers, tls.ok ? tls.tls : {})
      .flatMap((site) => site.hosts)
      .filter((h) => probeEligibility(h.host, h.state) === null)
      .map((h) => h.host);
  };
  const prober = new TlsProber({ addr: config.tlsProbeAddr });
  const sweep = new TlsSweep({
    prober,
    listHosts: listProbeHosts,
    onSwept: (hosts) => {
      for (const [host, result] of Object.entries(hosts)) {
        events.observe(`cert:${host}`, result.severity === "ok" ? "ok" : result.severity === "amber" ? "warning" : "down", result.reasons.join("; ") || undefined);
      }
      events.sync("cert" satisfies SubjectKind, Object.keys(hosts).map((host) => `cert:${host}`));
    },
  });
  void sweep.start();
  void new HostCheck({ addr: config.tlsProbeAddr, enabled: config.hostCheck, listHosts: listProbeHosts, events }).start();
  // History: newest first, optionally for one Subject.
  app.get("/api/events", (c) => {
    const subject = c.req.query("subject") || undefined;
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 200, 1), 500);
    return c.json({ ok: true, events: events.list({ subject, limit }) });
  });

  // Per host: the worst State among its Certificate, its synthetic check and its upstreams over a window.
  app.get("/api/events/timeline", async (c) => {
    const seconds = Number(c.req.query("window"));
    const windowMs = (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 30 * 86_400) : 86_400) * 1000;
    const servers = await admin.liveServers();
    if (!servers.ok) return c.json({ ok: false, error: servers.error }, 502);
    const to = Date.now();
    const from = to - windowMs;
    const hosts: Record<string, ReturnType<EventTracker["timeline"]>> = {};
    for (const site of summarizeRoutes(servers.servers)) {
      const upstreams = site.rules.flatMap((rule) => rule.destinations.flatMap((d) => d.upstreams ?? [])).map(upstreamKey);
      for (const host of site.hosts) hosts[host] = events.timeline([`cert:${host}`, `host:${host}`, ...upstreams], from, to);
    }
    return c.json({ ok: true, from, to, hosts });
  });

  // Whether alerting is on, never where it goes.
  app.get("/api/alerts", (c) => c.json({ ok: true, enabled: events.alertsEnabled }));
  // With a topic id it tests just that topic, even when it is switched off.
  app.post("/api/alerts/test", async (c) => {
    const { id } = await c.req.json<{ id?: unknown }>().catch(() => ({ id: undefined }));
    if (typeof id === "string") {
      const sender = alertSettings.senderFor(id);
      if (!sender) return c.json({ ok: false, error: "No such topic." }, 404);
      const result = await events.sendTest(undefined, sender);
      return c.json(result, result.ok ? 200 : 502);
    }
    const result = await events.sendTest();
    return c.json(result, result.ok ? 200 : 502);
  });

  // The alert settings. Topic addresses and tokens can be written but never read back, and with no login
  // they cannot be written either: anyone who can reach the page could send Alerts, and Fairway's requests, anywhere.
  const needsLogin = () => ({ ok: false as const, error: "Sign in is required to change where Alerts go. Set AUTH_USER and a password first." });
  const settingsView = () => ({ ok: true as const, canEditSecrets: auth.enabled, ...alertSettings.view(auth.enabled) });
  const answer = (result: { ok: boolean }) => (result.ok ? 200 : 400);

  app.get("/api/settings/alerts", (c) => c.json(settingsView()));

  app.put("/api/settings/alerts", async (c) => {
    const body = await c.req.json<Patch>().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ ok: false, error: "Send a JSON object." }, 400);
    const result = await alertSettings.patch({ triggers: body.triggers, timing: body.timing, reviewLevel: body.reviewLevel, publicUrl: body.publicUrl, hosts: body.hosts });
    return result.ok ? c.json(settingsView()) : c.json(result, answer(result));
  });

  app.post("/api/settings/alerts/topics", async (c) => {
    if (!auth.enabled) return c.json(needsLogin(), 403);
    const body = await c.req.json<{ name: string; url: string; token?: string | null }>().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ ok: false, error: "Send a JSON object." }, 400);
    const result = await alertSettings.addTopic(body);
    return result.ok ? c.json({ ...settingsView(), id: result.id }) : c.json(result, answer(result));
  });

  app.patch("/api/settings/alerts/topics/:id", async (c) => {
    const body = await c.req.json<TopicPatch>().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ ok: false, error: "Send a JSON object." }, 400);
    if (!auth.enabled && (body.url !== undefined || body.token !== undefined)) return c.json(needsLogin(), 403);
    const result = await alertSettings.updateTopic(c.req.param("id"), { name: body.name, url: body.url, token: body.token, enabled: body.enabled });
    return result.ok ? c.json(settingsView()) : c.json(result, result.error === "No such topic." ? 404 : 400);
  });

  app.delete("/api/settings/alerts/topics/:id", async (c) => {
    if (!auth.enabled) return c.json(needsLogin(), 403);
    const result = await alertSettings.removeTopic(c.req.param("id"));
    return result.ok ? c.json(settingsView()) : c.json(result, result.error === "No such topic." ? 404 : 400);
  });

  // The model endpoint. The key can be written but never read back, and with no login neither the address nor
  // the key can be written: Fairway would send the key and the Caddyfile to whatever address a visitor chose.
  const aiView = () => ({ ok: true as const, canEdit: auth.enabled, ...aiSettings.view() });

  app.get("/api/settings/ai", (c) => c.json(aiView()));

  app.put("/api/settings/ai", async (c) => {
    if (!auth.enabled) return c.json({ ok: false, error: "Sign in is required to change the model endpoint. Set AUTH_USER and a password first." }, 403);
    const body = await c.req.json<AiPatch>().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ ok: false, error: "Send a JSON object." }, 400);
    const result = await aiSettings.patch({ baseUrl: body.baseUrl, apiKey: body.apiKey, assistantModel: body.assistantModel, reviewModel: body.reviewModel, reviewInterval: body.reviewInterval, assistantPrice: body.assistantPrice });
    return result.ok ? c.json(aiView()) : c.json(result, 400);
  });

  // Tests the endpoint in force. It takes no address from the request, so it needs no login.
  app.post("/api/settings/ai/test", async (c) => {
    const result = await testConnection(aiSettings.effective());
    return c.json(result, result.ok ? 200 : 502);
  });

  // The endpoint's model list, for the pickers. An endpoint without a list answers 502 and the Owner types the name.
  app.get("/api/settings/ai/models", async (c) => {
    const result = await listModels(aiSettings.effective());
    return c.json(result, result.ok ? 200 : 502);
  });

  // Tests the model chosen for a task: one small request with one tool. It takes no address or model from the
  // request, only the task, so it needs no login.
  app.post("/api/settings/ai/test-model", async (c) => {
    const body = await c.req.json<{ task?: unknown }>().catch(() => null);
    const task = AI_TASKS.find((t) => t === body?.task) as AiTask | undefined;
    if (!task) return c.json({ ok: false, error: "Say which task to test: assistant or review." }, 400);
    const model = aiSettings.model(task);
    if (!model) return c.json({ ok: false, reason: "no_model", error: "Choose a model first." }, 400);
    const result = await testToolCalling(aiSettings.effective(), model);
    return c.json(result, result.ok ? 200 : 502);
  });

  // One turn of the Assistant in a stored Conversation, streamed. The browser sends the Conversation's id (null for a new
  // one), the editor buffer, the Owner's message and, when one is pending, that Proposal; the server keeps the
  // Conversation. Events: `conversation` {id, userMessageId, answerMessageId} first, then `text` {delta}, `context`
  // {parts: [{key, tokens}]} (the estimated sizes of what the request is made of), `step` {step} (what ran and how
  // long it took), `usage`
  // {usage: {promptTokens, completionTokens}}, `validating` {attempt}, `proposal` {text, valid, findings, attempts,
  // messageId}, `limit` {message}, `error` {reason, error}, and `done` last. Closing the request stops the model's answer too.
  app.post("/api/assistant/turn", async (c) => {
    if (!auth.enabled) return c.json({ ok: false, error: "Sign in is required to use the Assistant. Set AUTH_USER and a password first." }, 403);
    const model = aiSettings.model("assistant");
    if (!model) return c.json({ ok: false, error: "Choose a model for the Assistant in Settings first." }, 409);
    const checked = checkTurnBody(await c.req.json().catch(() => null));
    if (!checked.ok) return c.json(checked, 400);
    const controller = new AbortController();
    const deps = { endpoint: aiSettings.effective(), model, validate: async (text: string) => (await deployer.validate(text)).findings, signal: controller.signal };
    const started = startConversationTurn(conversations, deps, checked.body);
    if (!started.ok) return c.json({ ok: false, error: started.error }, started.status);
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => controller.abort());
      for await (const event of started.events) {
        if (controller.signal.aborted) break;
        const { type, ...data } = event;
        await stream.writeSSE({ event: type, data: JSON.stringify(data) });
      }
      if (!controller.signal.aborted) await stream.writeSSE({ event: "done", data: "{}" });
    });
  });

  // The stored Conversations: masked text only. Behind a Session, and refused without a login like the turn.
  const conversationsGate = (): Response | null => (auth.enabled ? null : Response.json({ ok: false, error: "Sign in is required to use the Assistant. Set AUTH_USER and a password first." }, { status: 403 }));
  app.get("/api/assistant/conversations", (c) => conversationsGate() ?? c.json({ ok: true, conversations: conversations.list() }));
  app.get("/api/assistant/conversations/:id", (c) => {
    const found = conversationsGate() ?? conversations.get(c.req.param("id"));
    if (found instanceof Response) return found;
    return found ? c.json({ ok: true, conversation: { id: found.id, title: found.title, updatedAt: found.updatedAt, usage: found.usage, messages: found.messages } }) : c.json({ ok: false, error: "No such Conversation." }, 404);
  });
  app.delete("/api/assistant/conversations/:id", async (c) => {
    const gate = conversationsGate();
    if (gate) return gate;
    return (await conversations.delete(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ ok: false, error: "No such Conversation." }, 404);
  });
  app.put("/api/assistant/conversations/:id/messages/:messageId/proposal", async (c) => {
    const gate = conversationsGate();
    if (gate) return gate;
    const { status } = ((await c.req.json().catch(() => null)) ?? {}) as { status?: unknown };
    if (status !== "accepted" && status !== "rejected" && status !== "outdated") return c.json({ ok: false, error: "A Proposal can be set to accepted, rejected or outdated." }, 400);
    const result = conversations.decide(c.req.param("id"), Number(c.req.param("messageId")), status);
    if (result === "missing") return c.json({ ok: false, error: "No such Proposal." }, 404);
    if (result === "settled") return c.json({ ok: false, error: "That Proposal has already been decided." }, 409);
    await conversations.save();
    return c.json({ ok: true });
  });

  // Reviews: an AI model reads a digest of the Access logs (ADR 0009). Starting returns at once; the Review runs in
  // the background and the list shows it as running until it is done or failed.
  app.get("/api/reviews", (c) => c.json({ ok: true, running: reviews.running(), reviews: reviews.list(), schedule: reviewSchedule.status() }));

  app.post("/api/reviews", async (c) => {
    const result = await reviews.start();
    return result.ok ? c.json({ ok: true, review: result.review }, 202) : c.json({ ok: false, error: result.error }, result.status);
  });

  app.get("/api/reviews/:id", (c) => {
    const review = reviews.get(Number(c.req.param("id")));
    return review ? c.json({ ok: true, review }) : c.json({ ok: false, error: "No such Review." }, 404);
  });

  app.get("/api/tls/status", (c) => c.json(sweep.snapshot()));
  app.get("/api/tls/probe", async (c) => {
    if (!prober.enabled) return c.json({ ok: true, enabled: false });
    const host = c.req.query("host") ?? "";
    const servers = await admin.liveServers();
    if (!servers.ok) return c.json({ ok: false, error: servers.error }, 502);
    const tls = await admin.liveTls();
    const entry = summarizeTls(servers.servers, tls.ok ? tls.tls : {})
      .flatMap((site) => site.hosts)
      .find((h) => h.host === host);
    if (!entry) return c.json({ ok: false, error: "Unknown host." }, 404);
    const skipped = probeEligibility(entry.host, entry.state);
    if (skipped) return c.json({ ok: true, enabled: true, skipped });
    return c.json({ ok: true, enabled: true, probe: await prober.check(entry.host, { force: c.req.query("force") === "1" }) });
  });

  app.get("/api/tls/last-error", async (c) => {
    const host = c.req.query("host") ?? "";
    if (!host) return c.json({ ok: false, error: "host is required" }, 400);
    return c.json({ ok: true, error: lastIssuanceError(await tailLines(logPath, 5000), host) });
  });

  app.post("/api/format", async (c) => {
    const { text } = await c.req.json<{ text: string }>();
    return c.json(await formatCaddyfile(text, config.caddyBin));
  });

  const runDeploy = async (run: () => ReturnType<Deployer["deploy"]>) => {
    try {
      const result = await run();
      void refreshRouteMap();
      return { status: 200 as const, body: { ok: true, ...result, hash: result.revision.hash } };
    } catch (error) {
      if (error instanceof DeployError) {
        const status = error.failure.code === "conflict" ? 409 : error.failure.code === "invalid" ? 422 : 502;
        return { status: status as 409 | 422 | 502, body: { ok: false, ...error.failure } };
      }
      throw error;
    }
  };

  app.post("/api/deploy", async (c) => {
    const body = await c.req.json<{ text: string; baseHash: string; force?: boolean; note?: string }>();
    const { status, body: reply } = await runDeploy(() => deployer.deploy(body));
    return c.json(reply, status);
  });

  app.get("/api/revisions", async (c) => c.json({ revisions: store.list(), hasOriginal: (await store.getOriginal()) !== null }));

  app.get("/api/revisions/:id", async (c) => {
    const id = c.req.param("id");
    if (id === "original") return c.json({ meta: { id: "original" }, text: await store.getOriginal() });
    const revision = await store.get(Number(id));
    return revision ? c.json(revision) : c.json({ error: "No such revision" }, 404);
  });

  app.post("/api/rollback", async (c) => {
    const body = await c.req.json<{ id: number | "original"; baseHash: string; force?: boolean }>();
    const target = body.id === "original" ? await store.getOriginal() : (await store.get(Number(body.id)))?.text;
    if (target == null) return c.json({ error: "No such revision" }, 404);
    const { status, body: reply } = await runDeploy(
      () =>
        deployer.deploy({
          text: target,
          baseHash: body.baseHash,
          force: body.force,
          note: `Rollback to ${body.id === "original" ? "the Original" : `revision ${body.id}`}`,
          rollbackOf: body.id,
        }),
    );
    return c.json(reply, status);
  });

  app.get("/api/logs", async (c) => {
    const lines = Math.min(Number(c.req.query("lines") ?? 500), 5000);
    return c.json({ lines: await tailLines(logPath, lines) });
  });

  app.get("/api/logs/stream", (c) =>
    streamSSE(c, async (stream) => {
      const follower = new LogFollower(logPath, (lines) => {
        void stream.writeSSE({ data: JSON.stringify(lines) });
      });
      await follower.start();
      stream.onAbort(() => follower.stop());
      while (!stream.aborted) {
        await stream.writeSSE({ event: "ping", data: "" });
        await stream.sleep(20_000);
      }
      follower.stop();
    }),
  );

  app.use("/*", serveStatic({ root: config.webRoot }));

  // Single-page app: a page address that matched no file gets the shell, so the browser router can take over.
  // /api, other methods and anything whose last segment has a dot (an asset) keep their plain 404.
  app.use("/*", async (c, next) => {
    const path = c.req.path;
    const isPage = (c.req.method === "GET" || c.req.method === "HEAD") && path !== "/api" && !path.startsWith("/api/") && !(path.split("/").pop() ?? "").includes(".");
    if (!isPage) return next();
    try {
      const html = await readFile(join(config.webRoot, "index.html"), "utf8");
      return c.html(html, 200, { "Cache-Control": "no-cache" });
    } catch {
      return next();
    }
  });
  return app;
}
