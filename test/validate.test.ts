import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CaddyAdmin } from "../src/server/caddy-admin.js";
import { Deployer } from "../src/server/deploy.js";
import { errorFinding } from "../src/server/findings.js";
import { Store } from "../src/server/store.js";

const messages = {
  leading: "adapting config using caddyfile adapter: Caddyfile:2: unrecognized directive: foo",
  trailing:
    "adapting config using caddyfile adapter: syntax error: unexpected token 'localhost:1', expecting '}', at Caddyfile:2 import chain: ['']",
  noLine: "adapting config using caddyfile adapter: ambiguous site definition: a.test",
};

describe("errorFinding", () => {
  it("reads the line right after the file name", () => {
    assert.deepEqual(errorFinding(messages.leading), {
      level: "error",
      message: "unrecognized directive: foo",
      line: 2,
      origin: "caddy",
    });
  });

  it("reads the line after 'at'", () => {
    assert.deepEqual(errorFinding(messages.trailing), {
      level: "error",
      message: "syntax error: unexpected token 'localhost:1', expecting '}'",
      line: 2,
      origin: "caddy",
    });
  });

  it("gives no line when the message has none", () => {
    const finding = errorFinding(messages.noLine);
    assert.equal(finding.message, "ambiguous site definition: a.test");
    assert.equal("line" in finding, false);
  });
});

describe("validate against Caddy's /adapt", () => {
  let deployer: Deployer;
  let close: () => Promise<void>;

  before(async () => {
    const dir = await mkdtemp(join(tmpdir(), "ce-validate-"));
    const socket = join(dir, "admin.sock");
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const send = (status: number, payload: object) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (body.includes("LEADING")) return send(400, { error: messages.leading });
        if (body.includes("TRAILING")) return send(400, { error: messages.trailing });
        if (body.includes("NOLINE")) return send(400, { error: messages.noLine });
        if (body.includes("WARN")) {
          return send(200, { result: {}, warnings: [{ file: "Caddyfile", line: 3, message: "Caddyfile input is not formatted" }, { message: "no line here" }] });
        }
        if (body.includes("RULES")) {
          const route = { match: [{ host: ["bare.test"] }], handle: [{ handler: "static_response" }] };
          return send(200, { result: { apps: { http: { metrics: {}, servers: { srv0: { routes: [route] } } } } }, warnings: [{ file: "Caddyfile", line: 1, message: "from caddy" }] });
        }
        send(200, { result: {}, warnings: [] });
      });
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const store = new Store(join(dir, "data"), 5);
    await store.init();
    deployer = new Deployer(join(dir, "Caddyfile"), new CaddyAdmin(socket), store);
  });
  after(() => close());

  it("returns one error Finding with its line for a rejection", async () => {
    assert.deepEqual(await deployer.validate("LEADING"), {
      ok: false,
      findings: [{ level: "error", message: "unrecognized directive: foo", line: 2, origin: "caddy" }],
    });
    const trailing = await deployer.validate("TRAILING");
    assert.equal(trailing.findings[0]?.line, 2);
  });

  it("keeps an error without a line lineless", async () => {
    const result = await deployer.validate("NOLINE");
    assert.equal(result.ok, false);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.line, undefined);
  });

  it("returns warnings as Findings, keeping their line", async () => {
    assert.deepEqual(await deployer.validate("WARN"), {
      ok: true,
      findings: [
        { level: "warning", message: "Caddyfile input is not formatted", line: 3, origin: "caddy" },
        { level: "warning", message: "no line here", origin: "caddy" },
      ],
    });
  });

  it("returns no Findings for a clean Caddyfile", async () => {
    assert.deepEqual(await deployer.validate("a.test {\n}\n"), { ok: true, findings: [] });
  });

  it("puts rule Findings next to Caddy's warnings", async () => {
    const result = await deployer.validate("# RULES\nbare.test {\n}\n");
    assert.equal(result.ok, true);
    assert.deepEqual(result.findings.map((f) => [f.origin, f.level, f.line]), [["caddy", "warning", 1], ["rules", "warning", 2]]);
    assert.match(result.findings[1]!.message, /bare\.test/);
  });

  it("keeps Caddy's answer when a rule throws", async () => {
    const original = deployer.rules;
    deployer.rules = () => {
      throw new Error("boom");
    };
    try {
      const result = await deployer.validate("# RULES\nbare.test {\n}\n");
      assert.deepEqual(result.findings.map((f) => f.origin), ["caddy"]);
      assert.equal(result.ok, true);
    } finally {
      deployer.rules = original;
    }
  });

  it("rejects an empty Caddyfile", async () => {
    const result = await deployer.validate("  ");
    assert.equal(result.ok, false);
  });
});
