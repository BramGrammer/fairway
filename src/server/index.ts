import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const onShutdown: Array<() => Promise<void>> = [];
const app = await createApp(config, onShutdown);

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, ({ port }) => {
  console.log(`fairway listening on :${port} (${config.authUser ? "login required" : "no authentication"})`);
});

// `docker stop` sends SIGTERM: save what is kept in memory before leaving.
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void Promise.allSettled(onShutdown.map((fn) => fn())).then(() => {
      server.close();
      process.exit(0);
    });
  });
}
