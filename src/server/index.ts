import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await createApp(config);

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, ({ port }) => {
  console.log(`fairway listening on :${port} (no authentication)`);
});
