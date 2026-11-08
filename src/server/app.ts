import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { join } from "node:path";
import { CaddyAdmin } from "./caddy-admin.js";
import type { Config } from "./config.js";
import { DeployError, Deployer } from "./deploy.js";
import { formatCaddyfile } from "./format.js";
import { LogFollower, tailLines } from "./logs.js";
import { MetricsTracker, WINDOWS_MS } from "./metrics.js";
import { summarizeRoutes } from "./routes.js";
import { Store } from "./store.js";
import { lastIssuanceError } from "./issuance.js";
import { summarizeTls } from "./tls.js";
import { probeEligibility, TlsProber } from "./tls-probe.js";
import { TlsSweep } from "./tls-sweep.js";

export async function createApp(config: Config) {
  const admin = new CaddyAdmin(config.adminSocket);
  const metrics = new MetricsTracker(admin);
  metrics.start();
  const store = new Store(config.dataDir, config.maxRevisions);
  await store.init();
  const deployer = new Deployer(config.caddyfilePath, admin, store);
  await deployer.ensureOriginal();

  const app = new Hono();
  const logPath = join(config.logDir, config.logFile);

  app.use("/api/*", async (c, next) => {
    if (config.requireTailscaleLogin) {
      const login = c.req.header("Tailscale-User-Login");
      if (login !== config.requireTailscaleLogin) {
        return c.json({ error: "This Tailscale user is not allowed to use the editor." }, 403);
      }
    }
    await next();
  });

  app.get("/api/status", async (c) =>
    c.json({
      caddyReachable: await admin.ping(),
      auth: config.requireTailscaleLogin
        ? { mode: "tailscale", user: c.req.header("Tailscale-User-Login") ?? null }
        : { mode: "none" },
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

  app.get("/api/upstreams", async (c) => {
    const result = await admin.upstreams();
    return result.ok ? c.json(result) : c.json(result, 502);
  });

  const prober = new TlsProber({ addr: config.tlsProbeAddr });
  const sweep = new TlsSweep({
    prober,
    listHosts: async () => {
      const servers = await admin.liveServers();
      if (!servers.ok) throw new Error(servers.error);
      const tls = await admin.liveTls();
      return summarizeTls(servers.servers, tls.ok ? tls.tls : {})
        .flatMap((site) => site.hosts)
        .filter((h) => probeEligibility(h.host, h.state) === null)
        .map((h) => h.host);
    },
  });
  void sweep.start();
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
  return app;
}
