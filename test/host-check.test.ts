import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EventTracker } from "../src/server/events.js";
import { CHECK_MS, HostCheck, requestHost, type RequestResult } from "../src/server/host-check.js";

const T0 = Date.parse("2030-01-01T00:00:00Z");

function setup(opts: {
  enabled?: boolean;
  addr?: string | null;
  hosts?: () => Promise<string[]>;
  respond?: (host: string) => RequestResult | Promise<RequestResult>;
} = {}) {
  const events = new EventTracker();
  const requested: { host: string; port: number; target: string }[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  let clock = T0;
  const check = new HostCheck({
    addr: opts.addr === undefined ? "caddy.example.test:443" : opts.addr,
    enabled: opts.enabled ?? true,
    listHosts: opts.hosts ?? (async () => ["a.test"]),
    events,
    now: () => clock,
    request: async (target, host) => {
      requested.push({ host, port: target.port, target: target.host });
      return (await opts.respond?.(host)) ?? { status: 200 };
    },
    schedule: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return () => {
        t.cleared = true;
      };
    },
  });
  /** Runs one pass five minutes after the previous one. */
  const tick = async () => {
    await check.runOnce();
    clock += CHECK_MS;
  };
  return { check, events, requested, timers, tick };
}

describe("HostCheck", () => {
  it("treats 200 and other 5xx as ok", async () => {
    for (const status of [200, 301, 404, 500]) {
      const { events, tick } = setup({ respond: () => ({ status }) });
      await tick();
      await tick();
      await tick();
      assert.equal(events.stateOf("host:a.test"), "ok", `status ${status}`);
    }
  });

  it("treats 502, 503 and 504 as down after two failures in a row", async () => {
    for (const status of [502, 503, 504]) {
      const { events, tick } = setup({ respond: () => ({ status }) });
      await tick();
      assert.equal(events.stateOf("host:a.test"), null);
      await tick();
      assert.equal(events.stateOf("host:a.test"), "down", `status ${status}`);
    }
  });

  it("one failure between good runs does not change state", async () => {
    let n = 0;
    const { events, tick } = setup({ respond: () => ({ status: ++n === 2 ? 502 : 200 }) });
    await tick();
    await tick();
    await tick();
    assert.equal(events.stateOf("host:a.test"), "ok");
    assert.equal(events.list({ subject: "host:a.test" }).length, 1);
  });

  it("counts connection errors and timeouts as down, and recovers", async () => {
    let result: RequestResult = { error: "timed out" };
    const { events, tick } = setup({ respond: () => result });
    await tick();
    await tick();
    assert.equal(events.stateOf("host:a.test"), "down");
    assert.equal(events.list({ subject: "host:a.test" })[0].message.includes("timed out"), true);
    result = { status: 200 };
    await tick();
    await tick(); // recovery is debounced like a failure
    assert.equal(events.stateOf("host:a.test"), "ok");
  });

  it("counts a throwing request as down without stopping other hosts", async () => {
    const { events, tick, requested } = setup({
      hosts: async () => ["boom.test", "b.test"],
      respond: (host) => {
        if (host === "boom.test") throw new Error("boom");
        return { status: 200 };
      },
    });
    await tick();
    await tick();
    assert.equal(events.stateOf("host:boom.test"), "down");
    assert.equal(events.stateOf("host:b.test"), "ok");
    assert.equal(requested.length, 4);
  });

  it("requests only the listed hosts, at the probe address", async () => {
    const { tick, requested } = setup({ hosts: async () => ["a.test", "b.test"], addr: "10.0.0.2:8443" });
    await tick();
    assert.deepEqual(requested.map((r) => r.host).sort(), ["a.test", "b.test"]);
    assert.equal(requested[0].target, "10.0.0.2");
    assert.equal(requested[0].port, 8443);
  });

  it("syncs removed hosts out", async () => {
    let hosts = ["a.test", "b.test"];
    const { events, tick } = setup({ hosts: async () => hosts });
    await tick();
    assert.equal(events.stateOf("host:b.test"), "ok");
    hosts = ["a.test"];
    await tick();
    assert.equal(events.stateOf("host:b.test"), null);
    assert.equal(events.stateOf("host:a.test"), "ok");
  });

  it("changes nothing when listing fails", async () => {
    let fail = false;
    const { events, tick, requested } = setup({
      hosts: async () => {
        if (fail) throw new Error("caddy down");
        return ["a.test"];
      },
    });
    await tick();
    fail = true;
    await tick();
    assert.equal(events.stateOf("host:a.test"), "ok");
    assert.equal(requested.length, 1);
  });

  it("limits concurrency", async () => {
    let active = 0;
    let peak = 0;
    const { tick } = setup({
      hosts: async () => Array.from({ length: 12 }, (_, i) => `h${i}.test`),
      respond: async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { status: 200 };
      },
    });
    await tick();
    assert.ok(peak > 1 && peak <= 4, `peak ${peak}`);
  });

  it("stays off without the opt-in or without an address", async () => {
    for (const o of [{ enabled: false }, { addr: null }]) {
      const { check, requested, timers } = setup(o);
      await check.start();
      assert.equal(check.enabled, false);
      assert.equal(requested.length, 0);
      assert.equal(timers.length, 0);
    }
  });

  it("runs on start, then every 5 minutes until stopped", async () => {
    const { check, requested, timers } = setup();
    await check.start();
    assert.equal(requested.length, 1);
    assert.equal(timers[0].ms, 5 * 60_000);
    timers[0].fn();
    await check.runOnce();
    assert.equal(requested.length, 2);
    check.stop();
    assert.equal(timers[0].cleared, true);
  });
});

describe("requestHost", () => {
  let tls: { key: string; cert: string } | null = null;
  try {
    const dir = mkdtempSync(join(tmpdir(), "hostcheck-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-subj", "/CN=other.test", "-days", "1"], { stdio: "ignore" });
    tls = { key: readFileSync(join(dir, "k.pem"), "utf8"), cert: readFileSync(join(dir, "c.pem"), "utf8") };
  } catch {
    tls = null;
  }

  it("sends Host and SNI, ignores certificate errors and redirects", { skip: !tls }, async () => {
    const seen: { host?: string; sni?: string; url?: string } = {};
    const server = https.createServer({ ...tls! }, (req, res) => {
      seen.host = req.headers.host;
      seen.url = req.url;
      res.writeHead(302, { location: "https://elsewhere.test/" });
      res.end("body");
    });
    server.on("secureConnection", (socket) => {
      seen.sni = (socket as unknown as { servername?: string }).servername;
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const result = await requestHost({ host: "127.0.0.1", port }, "app.example.test");
      assert.deepEqual(result, { status: 302 });
      assert.equal(seen.host, "app.example.test");
      assert.equal(seen.sni, "app.example.test");
      assert.equal(seen.url, "/");
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  it("reports a refused connection as an error", async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    const result = await requestHost({ host: "127.0.0.1", port }, "a.test");
    assert.ok("error" in result);
  });

  it("reports a silent server as timed out", async () => {
    const sockets = new Set<net.Socket>();
    const silent = net.createServer((socket) => sockets.add(socket));
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    try {
      const port = (silent.address() as AddressInfo).port;
      assert.deepEqual(await requestHost({ host: "127.0.0.1", port }, "a.test", 100), { error: "timed out" });
    } finally {
      for (const socket of sockets) socket.destroy();
      silent.close();
    }
  });
});
