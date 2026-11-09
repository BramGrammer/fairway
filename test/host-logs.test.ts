import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { LogFollower } from "../src/server/logs.js";
import { parseHostLines, readHostLog, resolutionKey, resolveHostLogFile } from "../src/server/host-logs.js";

async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ce-hostlog-"));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

function entry(host: string, extra: { ts?: number; uri?: string; clientIp?: string; remoteIp?: string; status?: number } = {}): string {
  return JSON.stringify({
    level: "info",
    ts: extra.ts ?? 1_700_000_000,
    logger: "http.log.access",
    msg: "handled request",
    request: {
      remote_ip: extra.remoteIp ?? "10.0.0.9",
      ...(extra.clientIp && { client_ip: extra.clientIp }),
      remote_addr: `${extra.remoteIp ?? "10.0.0.9"}:51000`,
      method: "GET",
      host,
      uri: extra.uri ?? "/",
      headers: { "User-Agent": ["curl/8"] },
    },
    duration: 0.012,
    size: 512,
    status: extra.status ?? 200,
  });
}

const file = (filename: string) => ({ output: "file", filename });
const servers = (logs: object) => ({ srv0: { logs } });

describe("readHostLog", () => {
  it("reads a host's own file and maps the path into the folder by file name", async () => {
    const logDir = await folder({ "web.log": [entry("app.example.test", { uri: "/a" }), entry("app.example.test", { uri: "/b" })].join("\n") + "\n" });
    const result = await readHostLog({
      logging: { logs: { log0: { writer: file("/var/log/caddy/web.log") } } },
      servers: servers({ logger_names: { "app.example.test": ["log0"] } }),
      logDir,
      host: "app.example.test",
      limit: 10,
    });
    assert.ok(result.ok);
    assert.equal(result.file, "web.log");
    assert.deepEqual(result.lines.map((l) => l.uri), ["/a", "/b"]);
    assert.equal(result.lines[0].status, 200);
    assert.equal(result.lines[0].method, "GET");
    assert.equal(result.lines[0].userAgent, "curl/8");
    assert.equal(result.lines[0].time, 1_700_000_000_000);
  });

  it("only shows each host its own lines when two hosts share a file", async () => {
    const logDir = await folder({
      "shared.log": [entry("one.example.test", { uri: "/1" }), entry("two.example.test", { uri: "/2" }), entry("ONE.example.test", { uri: "/3" })].join("\n") + "\n",
    });
    const config = {
      logging: { logs: { log0: { writer: file("/logs/shared.log") } } },
      servers: servers({ logger_names: { "one.example.test": "log0", "two.example.test": ["log0"] } }),
      logDir,
      limit: 10,
    };
    const one = await readHostLog({ ...config, host: "one.example.test" });
    const two = await readHostLog({ ...config, host: "two.example.test" });
    assert.ok(one.ok && two.ok);
    assert.deepEqual(one.lines.map((l) => l.uri), ["/1", "/3"]);
    assert.deepEqual(two.lines.map((l) => l.uri), ["/2"]);
  });

  it("uses the default logger for a host without its own log block", async () => {
    const logDir = await folder({ "runtime.log": entry("plain.example.test") + "\n" });
    const result = await readHostLog({
      logging: { logs: { default: { writer: file("/logs/runtime.log") }, log0: { writer: file("/logs/web.log") } } },
      servers: servers({ logger_names: { "other.example.test": "log0" } }),
      logDir,
      host: "plain.example.test",
      limit: 10,
    });
    assert.ok(result.ok);
    assert.equal(result.file, "runtime.log");
    assert.equal(result.lines.length, 1);
  });

  it("handles the adapted shape: empty logger name means default, skip_hosts carry ports, include/exclude split the loggers", async () => {
    const logDir = await folder({
      "access-public.log": entry("pub.example.test", { uri: "/pub" }) + "\n",
      "runtime.log": entry("plain.example.test", { uri: "/plain" }) + "\n",
    });
    const logging = {
      logs: {
        default: { writer: file("/var/log/caddy/runtime.log"), exclude: ["http.log.access.internal", "http.log.access.public"] },
        public: { writer: file("/var/log/caddy/access-public.log"), include: ["http.log.access.public"] },
      },
    };
    const srv = { srv0: { logs: { logger_names: { "pub.example.test": ["public"], "plain.example.test": [""] } } }, srv1: { logs: { skip_hosts: ["off.example.test:8080"] } } };
    const run = (host: string) => readHostLog({ logging, servers: srv, logDir, host, limit: 5 });
    const pub = await run("pub.example.test");
    assert.ok(pub.ok);
    assert.deepEqual(pub.lines.map((l) => l.uri), ["/pub"]);
    const plain = await run("plain.example.test");
    assert.ok(plain.ok);
    assert.equal(plain.file, "runtime.log");
    assert.deepEqual(await run("off.example.test:8080"), { ok: false, reason: "not-logged" });
  });

  it("honours default_logger_name", async () => {
    const logDir = await folder({ "named.log": entry("plain.example.test") + "\n" });
    const result = await readHostLog({
      logging: { logs: { catchall: { writer: file("/logs/named.log") } } },
      servers: servers({ default_logger_name: "catchall" }),
      logDir,
      host: "plain.example.test",
      limit: 10,
    });
    assert.ok(result.ok);
    assert.equal(result.file, "named.log");
  });

  it("says a host is not logged when it is skipped, unmapped hosts are skipped, or access is excluded from the logger", async () => {
    const logDir = await folder({ "web.log": "" });
    const logging = { logs: { default: { writer: file("/logs/web.log") } } };
    const base = { logDir, limit: 5 };
    const skipped = await readHostLog({ ...base, logging, servers: servers({ skip_hosts: ["quiet.example.test"] }), host: "quiet.example.test" });
    assert.deepEqual(skipped, { ok: false, reason: "not-logged" });
    const unmapped = await readHostLog({ ...base, logging, servers: servers({ skip_unmapped_hosts: true }), host: "quiet.example.test" });
    assert.deepEqual(unmapped, { ok: false, reason: "not-logged" });
    const noLogs = await readHostLog({ ...base, logging, servers: { srv0: {} }, host: "quiet.example.test" });
    assert.deepEqual(noLogs, { ok: false, reason: "not-logged" });
    const excluded = await readHostLog({
      ...base,
      logging: { logs: { default: { writer: file("/logs/web.log"), exclude: ["http.log.access"] } } },
      servers: servers({}),
      host: "quiet.example.test",
    });
    assert.deepEqual(excluded, { ok: false, reason: "not-logged" });
    const specific = await readHostLog({
      ...base,
      logging: { logs: { default: { writer: file("/logs/web.log"), exclude: ["http.log.access.log0"] }, log0: { writer: file("/logs/web.log"), exclude: ["http.log.access.log0"] } } },
      servers: servers({ logger_names: { "quiet.example.test": "log0" } }),
      host: "quiet.example.test",
    });
    assert.deepEqual(specific, { ok: false, reason: "not-logged" });
  });

  it("explains stdout, stderr and network writers, and a logger without a writer", async () => {
    const logDir = await folder({});
    const run = (writer: object | undefined) =>
      readHostLog({
        logging: { logs: { default: writer ? { writer } : {} } },
        servers: servers({}),
        logDir,
        host: "a.example.test",
        limit: 5,
      });
    assert.deepEqual(await run({ output: "stdout" }), { ok: false, reason: "no-file-writer", output: "stdout" });
    assert.deepEqual(await run({ output: "stderr" }), { ok: false, reason: "no-file-writer", output: "stderr" });
    assert.deepEqual(await run({ output: "net", address: "tcp/logs.example.test:5000" }), { ok: false, reason: "no-file-writer", output: "net" });
    assert.deepEqual(await run(undefined), { ok: false, reason: "no-file-writer", output: "stderr" });
  });

  it("names the expected file when it does not exist yet", async () => {
    const logDir = await folder({ "unrelated.log": "x\n" });
    const result = await readHostLog({
      logging: { logs: { default: { writer: file(join(logDir, "later.log")) } } },
      servers: servers({}),
      logDir,
      host: "a.example.test",
      limit: 5,
    });
    assert.deepEqual(result, { ok: false, reason: "missing-file", file: "later.log", configuredPath: join(logDir, "later.log") });
  });

  it("names the configured path when Caddy writes outside the mounted folder", async () => {
    const logDir = await folder({});
    const result = await readHostLog({
      logging: { logs: { default: { writer: file("/srv/elsewhere/other.log") } } },
      servers: servers({}),
      logDir,
      host: "a.example.test",
      limit: 5,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result, { ok: false, reason: "missing-file", file: "other.log", configuredPath: "/srv/elsewhere/other.log" });
  });

  it("returns an empty list, not an error, for a quiet host", async () => {
    const logDir = await folder({ "web.log": entry("busy.example.test") + "\n" });
    const result = await readHostLog({
      logging: { logs: { default: { writer: file("/logs/web.log") } } },
      servers: servers({}),
      logDir,
      host: "quiet.example.test",
      limit: 5,
    });
    assert.deepEqual(result, { ok: true, file: "web.log", lines: [] });
  });

  it("finds a custom-port host by its bare name, keyed with or without the port", async () => {
    const logDir = await folder({ "internal.log": [entry("lan.example.test", { uri: "/x" })].join("\n") + "\n" });
    for (const key of ["lan.example.test:8443", "lan.example.test"]) {
      const result = await readHostLog({
        logging: { logs: { log1: { writer: file("/logs/internal.log") } } },
        servers: servers({ logger_names: { [key]: ["log1"] } }),
        logDir,
        host: "LAN.example.test:8443",
        limit: 5,
      });
      assert.ok(result.ok, key);
      assert.deepEqual(result.lines.map((l) => l.uri), ["/x"]);
    }
  });

  it("continues into rotated files, newest first, up to the limit, ignoring unrelated files", async () => {
    const logDir = await folder({
      "access.log": [entry("a.example.test", { uri: "/6" }), entry("b.example.test", { uri: "/other" }), entry("a.example.test", { uri: "/7" })].join("\n") + "\n",
      "access-2026-11-09T10-11-12.345.log": [entry("a.example.test", { uri: "/3" }), entry("a.example.test", { uri: "/4" }), entry("a.example.test", { uri: "/5" })].join("\n") + "\n",
      "access-2026-11-01T00-00-00.000.log": [entry("a.example.test", { uri: "/1" }), entry("a.example.test", { uri: "/2" })].join("\n") + "\n",
      "access-backup.log": entry("a.example.test", { uri: "/unrelated" }) + "\n",
      "other-2026-11-10T00-00-00.000.log": entry("a.example.test", { uri: "/unrelated2" }) + "\n",
      "access-2026-11-10T00-00-00.000.log.gz": "binary",
    });
    const config = {
      logging: { logs: { default: { writer: file("/logs/access.log") } } },
      servers: servers({}),
      logDir,
      host: "a.example.test",
    };
    const some = await readHostLog({ ...config, limit: 5 });
    assert.ok(some.ok);
    assert.deepEqual(some.lines.map((l) => l.uri), ["/3", "/4", "/5", "/6", "/7"]);
    const all = await readHostLog({ ...config, limit: 50 });
    assert.ok(all.ok);
    assert.deepEqual(all.lines.map((l) => l.uri), ["/1", "/2", "/3", "/4", "/5", "/6", "/7"]);
  });

  it("reads history from rotated files when the current file does not exist yet", async () => {
    const logDir = await folder({ "access-2026-11-09T10-11-12.345.log": entry("a.example.test", { uri: "/old" }) + "\n" });
    const result = await readHostLog({
      logging: { logs: { default: { writer: file("/logs/access.log") } } },
      servers: servers({}),
      logDir,
      host: "a.example.test",
      limit: 5,
    });
    assert.ok(result.ok);
    assert.deepEqual(result.lines.map((l) => l.uri), ["/old"]);
  });

  it("only reads a bounded tail of a very large file", async () => {
    const filler = entry("noise.example.test", { uri: "/" + "x".repeat(200) });
    const big = [entry("a.example.test", { uri: "/ancient" }), ...Array.from({ length: 5000 }, () => filler), entry("a.example.test", { uri: "/recent" })];
    const logDir = await folder({ "access.log": big.join("\n") + "\n" }); // about 1.3 MB
    const config = {
      logging: { logs: { default: { writer: file("/logs/access.log") } } },
      servers: servers({}),
      logDir,
      host: "a.example.test",
      limit: 10,
    };
    const bounded = await readHostLog({ ...config, maxBytesPerFile: 64 * 1024 });
    assert.ok(bounded.ok);
    assert.deepEqual(bounded.lines.map((l) => l.uri), ["/recent"]); // "/ancient" lies beyond the window
    const whole = await readHostLog({ ...config });
    assert.ok(whole.ok);
    assert.deepEqual(whole.lines.map((l) => l.uri), ["/ancient", "/recent"]);
  });

  it("skips malformed lines and lines without a request", async () => {
    const logDir = await folder({
      "access.log": ["not json", entry("a.example.test", { uri: "/ok" }), '{"truncated":', "[1,2]", '{"msg":"no request"}', ""].join("\n"),
    });
    const result = await readHostLog({
      logging: { logs: { default: { writer: file("/logs/access.log") } } },
      servers: servers({}),
      logDir,
      host: "a.example.test",
      limit: 10,
    });
    assert.ok(result.ok);
    assert.deepEqual(result.lines.map((l) => l.uri), ["/ok"]);
  });

  it("shows the real visitor behind a proxy, and the connection address otherwise", async () => {
    const logDir = await folder({
      "access.log": [entry("a.example.test", { clientIp: "203.0.113.7", remoteIp: "198.51.100.1", uri: "/p" }), entry("a.example.test", { remoteIp: "192.0.2.5", uri: "/d" })].join("\n") + "\n",
    });
    const result = await readHostLog({
      logging: { logs: { default: { writer: file("/logs/access.log") } } },
      servers: servers({}),
      logDir,
      host: "a.example.test",
      limit: 10,
    });
    assert.ok(result.ok);
    assert.deepEqual(result.lines.map((l) => l.client), ["203.0.113.7", "192.0.2.5"]);
  });
});

describe("live tail pieces", () => {
  it("keeps only the lines of the host, ignoring ports and junk", () => {
    const lines = [entry("app.example.test", { uri: "/a" }), entry("other.example.test"), "not json", entry("APP.example.test:8443", { uri: "/b" })];
    assert.deepEqual(parseHostLines(lines, "app.example.test").map((l) => l.uri), ["/a", "/b"]);
  });

  it("changes the resolution key when the host moves to another file", async () => {
    const logDir = await folder({ "a.log": "", "b.log": "" });
    const base = { logDir, host: "app.example.test" };
    const logging = (f: string) => ({ logs: { app: { writer: file(f) } } });
    const srv = servers({ logger_names: { "app.example.test": "app" } });
    const one = await resolveHostLogFile({ ...base, logging: logging("a.log"), servers: srv });
    const two = await resolveHostLogFile({ ...base, logging: logging("b.log"), servers: srv });
    assert.ok(one.ok && one.path === join(logDir, "a.log"));
    assert.notEqual(resolutionKey(one), resolutionKey(two));
    assert.equal(resolutionKey(one), resolutionKey(await resolveHostLogFile({ ...base, logging: logging("a.log"), servers: srv })));
  });

  it("filters lines followed from the resolved file", async () => {
    const logDir = await folder({ "web.log": entry("app.example.test") + "\n" });
    const resolved = await resolveHostLogFile({
      logDir,
      host: "app.example.test",
      logging: { logs: { app: { writer: file("web.log") } } },
      servers: servers({ logger_names: { "app.example.test": "app" } }),
    });
    assert.ok(resolved.ok);
    const seen: string[] = [];
    const follower = new LogFollower(resolved.path, (raw) => seen.push(...parseHostLines(raw, "app.example.test").map((l) => l.uri)), 20);
    await follower.start();
    await appendFile(resolved.path, [entry("app.example.test", { uri: "/new" }), entry("other.example.test", { uri: "/no" })].join("\n") + "\n");
    await sleep(80);
    follower.stop();
    assert.deepEqual(seen, ["/new"]);
  });
});
