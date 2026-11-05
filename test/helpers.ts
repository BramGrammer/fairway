import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaddyAdmin } from "../src/server/caddy-admin.js";
import { Deployer } from "../src/server/deploy.js";
import { Store } from "../src/server/store.js";

/** Stands in for Caddy: rejects text containing BAD on /adapt and LOADFAIL on /load. */
export async function fakeCaddy(socketPath: string) {
  const loaded: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const reply = (status: number, payload: object) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.url === "/config/") return reply(200, {});
      if (req.url === "/adapt") {
        return body.includes("BAD") ? reply(400, { error: "Caddyfile:1: bad directive" }) : reply(200, { result: {}, warnings: [] });
      }
      if (req.url === "/load") {
        if (body.includes("LOADFAIL")) return reply(400, { error: "port already in use" });
        loaded.push(body);
        return reply(200, {});
      }
      reply(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { loaded, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

export async function setup(initial = "example.com {\n\trespond hi\n}\n", maxRevisions = 50) {
  const dir = await mkdtemp(join(tmpdir(), "ce-"));
  const socketPath = join(dir, "admin.sock");
  const caddyfilePath = join(dir, "Caddyfile");
  await writeFile(caddyfilePath, initial);
  const caddy = await fakeCaddy(socketPath);
  const store = new Store(join(dir, "data"), maxRevisions);
  await store.init();
  const deployer = new Deployer(caddyfilePath, new CaddyAdmin(socketPath), store);
  await deployer.ensureOriginal();
  return { dir, caddyfilePath, caddy, store, deployer };
}
