# Competing and adjacent products: what Fairway could still learn

Research date 2026-11-10. Read-only; nothing in Fairway was changed. Sources are each product's own repository, README, docs and source tree. Stars and release dates were read from the GitHub API on the research date. Claims I could not confirm from a primary source are marked **unverified**. Plugin-specific panels (WAF, rate limit, cache, GeoIP, layer 4) are out of scope by the owner's decision, see `caddy-plugin-visibility.md`.

## Short answer

Fairway already covers most of what the Caddy-specific UIs offer (editor, validate, format, revisions with rollback, routes graph, per-host traffic with history, TLS probing, per-host logs, upstream state, login). The competitors that go beyond it do so in **one direction: proactive and over-time** (alerts, uptime history, config warnings). Fairway today only tells you something when you open it. Three candidates are worth building; the rest are marginal for one owner on a NAS, and I say so below instead of padding to eight.

## 1. Products

| Product | What it is | Activity (2026-11-10) | Notable features | Source |
|---|---|---|---|---|
| Nginx Proxy Manager | Form-driven proxy manager for Nginx in Docker | 34.7k stars, v2.16.0 on 2026-09-24, pushed yesterday | Proxy/redirect/404/stream hosts, Let's Encrypt or custom certs, access lists and basic auth, advanced Nginx snippet per host, users with permissions, audit log | [repo](https://github.com/NginxProxyManager/nginx-proxy-manager), [site](https://nginxproxymanager.com) |
| Traefik dashboard | Read-only view of Traefik's API | 65.5k stars, v3.7.18 on 2026-11-10 | Routers, services, middlewares, entry points and providers for HTTP, TCP and UDP; docs warn against exposing it in production | [docs](https://doc.traefik.io/traefik/reference/install-configuration/api-dashboard/) |
| Caddy admin API and docs | Caddy's own control surface (no UI) | 78.9k stars, v2.11.9 on 2026-11-05 | `/load`, `/adapt`, `/config`, `/id`, `/reverse_proxy/upstreams`, `/pki/ca/<id>`, `/metrics`; ETag with `If-Match`; automatic rollback on failed load | [API](https://caddyserver.com/docs/api), [metrics](https://caddyserver.com/docs/metrics) |
| caddy/ui (zackwag) | Docker web UI for Caddy via admin API; README says it was built with Claude, so closest in spirit to Fairway | 55 stars, v3.9.0 on 2026-11-06, very active | Caddyfile editor with history and rollback, route manager, certificates, logs, metrics with p50/p95/p99, **upstream and route uptime history, notifications (ntfy, Discord, Slack, Pushover, webhook)**, multi-instance, Homepage widget, Prometheus passthrough | [repo](https://github.com/zackwag/caddy-ui), [docs](https://zackwag.github.io/caddy-ui/) |
| CaddyManager | Multi-server Caddy web UI (MEVN) | 1.2k stars, last release 0.0.2 on 2025-09-07, last commit the same month (the repo shows a Feb 2026 push): effectively **stalled** | Multi-server, Caddyfile editor with templates, users and roles, API keys, audit log, health checks, Swagger | [repo](https://github.com/caddymanager/caddymanager) |
| jadylc/caddyUI | Chinese-language form-based Caddy panel | 12 stars, v1.2.0 on 2026-10-14, active | Form editing of sites, response-policy templates, error-page templates, an "operations observation" page that **lists config problems** (suspicious health checks, log patterns) and per-site recent errors, many ACME issuers | [repo](https://github.com/jadylc/caddyUI) |
| Other `caddy-ui` repos | qdm12/caddy-ui (104 stars, last push 2023), makinghappen/caddy-ui (2025), many 0 to 3 star repos | Mostly dead or hobby | Nothing not covered above | [search](https://github.com/search?q=caddy+ui&type=repositories) |
| caddy-docker-proxy | Caddy plugin: Docker labels generate the Caddyfile | 4.8k stars, v2.13.1 on 2026-07-02 | Config-from-labels, zero-downtime reload on container change | [repo](https://github.com/lucaslorentz/caddy-docker-proxy) |
| Zoraxy | Go reverse proxy with its own UI (not Caddy) | 5.6k stars, v3.3.5-rc5 on 2026-11-04 (only pre-releases at the top of the list, treat as beta) | Proxy rules, ACME with DNS challenge, allow/deny by IP or country, stream proxy, **uptime monitor** (HTTP pings with latency), **statistics**, plugin system, utilities (Wake-on-LAN, port and mDNS scan, web SSH) | [repo](https://github.com/tobychui/zoraxy), source dirs `src/mod/uptime`, `src/mod/statistic` |
| Nginx UI | Web UI for Nginx config and certs | 11.8k stars, v3.0.1 on 2026-11-07, very active | Config editor with auto test and reload, backup with version compare, site checks with alerts, notifications (ntfy, Telegram, email and more), log search with traffic dashboard, snippets and templates, cluster mirroring, AI assistant, MCP interface | [repo](https://github.com/0xJacky/nginx-ui), source dirs `internal/sitecheck`, `internal/notification`, `internal/backup` |
| Pangolin | Zero-trust tunnel and identity-aware reverse proxy platform | 23.6k stars, 1.26.0 on 2026-11-04, very active | WireGuard site connectors, identity-aware access per resource, RBAC, audit log, health checks with alerts when a resource goes down; Community edition AGPL, Enterprise edition commercial | [repo](https://github.com/fosrl/pangolin), [docs](https://docs.pangolin.net) |
| SWAG (LinuxServer) | Nginx plus Certbot plus fail2ban image, no UI | 3.8k stars, 5.9.0-ls498 on 2026-11-07 | Preset proxy-conf samples per app, fail2ban jail, auto cert renewal. Config is files only | [repo](https://github.com/linuxserver/docker-swag) |
| Cloudflare dashboard (hosted) | Hosted edge analytics and monitoring | n/a | Per-zone analytics (requests, bandwidth, top countries, threats; status and path filters only on paid plans), **Health Checks** (probe an origin, near-real-time alerts, uptime/latency/failure-reason history), notifications | [analytics](https://developers.cloudflare.com/analytics/account-and-zone-analytics/zone-analytics/), [health checks](https://developers.cloudflare.com/health-checks/) |

Not read in depth (low relevance): Nginx Proxy Manager forks, Nginx Proxy Manager Plus, Cosmos, Uptime Kuma. **Unverified** whether any of them has a feature not listed here.

## 2. Feature matrix

Legend: Y = has it, P = partly, N = no, n/a = does not apply. "Fairway" reflects the repo as of commit 66b9868.

| Feature | Fairway | caddy/ui | CaddyMgr | NPM | Traefik | Zoraxy | Nginx UI | Pangolin |
|---|---|---|---|---|---|---|---|---|
| Edit raw config in browser | Y | Y | Y | P (advanced box) | N | N | Y | N |
| Validate against the real binary | Y | Y | Y | n/a | n/a | n/a | Y | n/a |
| Format | Y | Y | N | n/a | n/a | n/a | N | n/a |
| Inline error markers at line and column | N (error shown as text, warnings carry a line) | **unverified** | **unverified** | n/a | n/a | n/a | P | n/a |
| Revisions, diff, rollback | Y (50 + Original) | Y | **unverified** | N | N | N | Y | N |
| Automatic restore if reload fails | Y | **unverified** | **unverified** | n/a | n/a | n/a | P | n/a |
| Routes view (graph and table) | Y | Y (table) | N | Y (host list) | Y | Y | N | Y |
| Per-host live traffic | Y | Y | P | N | P | Y | Y | P |
| Traffic history across restarts | Y (1 day fine-grained) | Y (7 days for uptime) | P (in-memory) | N | N | Y | Y | Y |
| Latency percentiles | N (average) | Y | N | N | N | **unverified** | **unverified** | **unverified** |
| Top paths, clients, errors from logs | N | N | N | N | N | Y | Y | N |
| Per-host access log with filter and stream | Y | P (global logs) | P | N | N | N | Y | P |
| Runtime log view | Y | Y | N | P | N | Y | Y | Y |
| TLS status per host, real certificate | Y (probe) | Y (store) | N | Y | P | Y | Y | P |
| Upstream health now | Y | Y | Y | N | Y | Y | P | Y |
| **Upstream or site uptime history** | **N** | **Y** | N | N | N | **Y** | **Y** | **Y** |
| **Alerts / notifications** | **N** | **Y** | N | N | N | N | **Y** | **Y** |
| **Config warnings (lint)** | **N** | N | N | N | N | N | P | N |
| Owner login | Y | Y | Y | Y | n/a | Y | Y | Y |
| Multi-user, roles | N (by design) | N | Y | Y | n/a | N | Y | Y |
| Multi-instance | N | Y | Y | N | n/a | N | Y | Y |
| Add-site form or wizard | N | Y | P (templates) | Y | N | Y | P | Y |
| Snippets or templates | N | N | Y | N | N | N | Y | N |
| Docker discovery | N | Y | N | N | Y | P | N | N |
| Read-only token, Homepage widget, Prometheus | N | Y | P (API keys) | N | Y (API) | N | N | Y |
| Config backup export | P (data dir) | Y | N | N | n/a | N | Y | n/a |

Cells marked **unverified** were not confirmed in the product's docs or source within this research.

## 3. Ranked candidates (missing in Fairway)

Ranking is by value to one owner running Caddy on a NAS, not by how common the feature is.

### 1. Alerts on state change (ntfy or generic webhook)

- **What:** Fairway pushes a short message when something turns bad, instead of waiting to be opened. Triggers: a certificate goes amber or red (the TLS sweep already computes this every 6 hours), an upstream goes down or recovers, Caddy's admin socket stops answering, a deploy fails or rolls back, an outside edit was snapshotted. A simple debounce so a flapping upstream does not spam.
- **Who does it:** caddy/ui (ntfy, Discord, Slack, Pushover, webhook, with debounce and trigger toggles; [README](https://github.com/zackwag/caddy-ui)), Nginx UI (site-health alert policy plus a dozen channels; `internal/sitecheck/alerts.go`, `internal/notification`), Pangolin (alerts when a resource goes down), Cloudflare Notifications and Health Checks.
- **Why it matters here:** this is the biggest real gap. The failure that hurts a home setup is silent: a renewal that has been failing for three weeks, or a container that died overnight. Fairway already detects the first (sweep) and shows the second, but only if the owner happens to look. One channel (ntfy or a webhook to whatever the owner already runs) is enough; no accounts or users needed.
- **Effort:** medium. The detection exists; new work is a small state store (last notified state per key), one HTTP sender, settings via environment variables (consistent with ADR 0005's "config from the environment"), and a test button. Settings in a UI would be large; start with env.
- **What Caddy exposes:** nothing new is required for TLS (existing probe) or deploys (Fairway's own events). Upstream state: `GET /reverse_proxy/upstreams` (address, `num_requests`, `fails`) which Fairway already reads, and the Prometheus gauge `caddy_reverse_proxy_upstreams_healthy` (label `upstream`; reflects **active** health checks only, verified in Caddy v2.11.9 `reverseproxy/hosts.go` and `metrics.go`). Failed reloads: `caddy_config_last_reload_successful` and `caddy_config_last_reload_success_timestamp_seconds` on `/metrics` ([source](https://github.com/caddyserver/caddy/blob/v2.11.9/metrics.go)). Caddy being down: `admin.ping()` already exists.
- **Caution:** an outbound webhook URL is a server-side request to an owner-supplied address; keep it env-only and do not echo it back through the API.

### 2. Uptime and state history per host and upstream

- **What:** a timeline per host (and per upstream) of up, down and degraded intervals plus recent 5xx bursts, kept for days, shown in the route drawer and as a small strip in the routes table. Optionally a synthetic check: Fairway requests `https://<host>/` against Caddy directly (reusing the address of `TLS_PROBE_ADDR`) and records status and latency, so "the proxy answers but the app returns 502" is visible even with no health check configured.
- **Who does it:** caddy/ui (upstream and optional route checks every 5 minutes, history 7 days by default, detects 5xx, timeouts and bad certificates), Zoraxy (`src/mod/uptime`: HTTP ping with latency and online/offline records), Nginx UI (`internal/sitecheck`), Cloudflare Health Checks (uptime, latency and failure-reason history).
- **Why it matters here:** answers "was it down last night, and for how long?" which the current one-day traffic chart cannot. It also gives candidate 1 a second signal. Pairs naturally with the existing persistent metrics store (`DATA_DIR/metrics.json`).
- **Effort:** medium. History only (from existing upstream polling plus 5xx deltas already in the metrics slices) is small; the synthetic check is the medium part and has side effects (a request per host per interval, possible log noise, and the same "can trigger issuance" caution as TLS probing for on-demand hosts).
- **What Caddy exposes:** `/reverse_proxy/upstreams`, `caddy_http_requests_total` by `code` per host (already parsed in `src/server/metrics.ts`), the healthy gauge above. A synthetic check needs no Caddy API, only a reachable listener.

### 3. Config warnings at validate time, plus inline error markers

- **What:** two parts. (a) Show Caddy's validation error as a marker at the offending line in CodeMirror (today the error is a text notice; warnings already carry `line`). (b) A short "worth a look" list shown with Validate and before Deploy, derived from the adapted JSON: host with no access log, host served over plain HTTP, admin endpoint on TCP instead of the socket, two sites claiming the same host, health check interval under one second or timeout above the interval (jadylc blocks exactly this because it floods logs), `metrics` not enabled so Traffic is empty, upstream name that does not resolve from Fairway's container (marked best effort).
- **Who does it:** jadylc/caddyUI has an "operations observation" page that lists suspicious health-check and log findings (README, Chinese). Nginx UI has `self_check` but it checks its own environment (directories, nginx.conf includes), not site config. So this is half borrowed, half Fairway's own idea; no competitor does a full lint. Marker-at-line is standard editor behaviour (the `@codemirror/lint` package; **unverified** whether any Caddy UI uses it).
- **Why it matters here:** the owner edits a hand-written Caddyfile with plugins. Catching a typo at its line and a few known foot-guns before Deploy is cheaper than discovering them from a 502. It is also the one candidate that reinforces what Fairway already is (an editor).
- **Effort:** small for markers (parse the line from the `/adapt` error; **unverified** that the message always contains `Caddyfile:<n>`, check against real errors), medium for the rule list (each rule is small; pick five).
- **What Caddy exposes:** `POST /adapt` (error text and warnings with file and line) and the adapted JSON that Fairway already fetches for the routes view; `GET /config/` for what is running.

### 4. Latency percentiles and error focus per host

- **What:** p50, p95 and p99 per host instead of only the average, and a "worst hosts right now" sort (5xx rate, p95).
- **Who does it:** caddy/ui (p50/p95/p99 from the Prometheus endpoint), jadylc (P95 and error trend).
- **Why it matters here:** an average hides a slow tail, which is usually what a self-hosted app shows when its disk or database is struggling. Honestly modest: one owner usually knows which app is slow.
- **Effort:** small to medium. Needs the histogram buckets, not just `_sum` and `_count`, stored in each slice (store grows by roughly the bucket count per host).
- **What Caddy exposes:** `caddy_http_request_duration_seconds_bucket` with `per_host` enabled ([metrics docs](https://caddyserver.com/docs/metrics)). Default buckets are Prometheus defaults (**unverified** against the pinned Caddy; check the actual `le` values).

### 5. Top paths, clients and failing URLs from the access log

- **What:** in the host drawer, a summary of the tail of that host's log: top paths, top client addresses, most common 4xx and 5xx URLs, slowest requests by `duration`.
- **Who does it:** Nginx UI (log search with index, traffic dashboard), Zoraxy (statistics module), Cloudflare (top countries; path and status breakdown only on paid plans).
- **Why it matters here:** useful when a host is reachable from outside: "what is being scanned" and "which URL keeps returning 404 or 500". Country views are out of scope (GeoIP decided no); keep it to paths and addresses.
- **Effort:** medium. The reader exists (`host-logs.ts`); aggregation over a bounded tail is small, but redaction and the "logs hold visitor addresses" note (ADR 0004) apply doubly to a summary.
- **What Caddy exposes:** the JSON access log fields (`request.uri`, `request.remote_ip` or `client_ip`, `status`, `duration`, `size`), no API.

### 6. Routing diff in the deploy review

- **What:** next to the text diff, a plain-language list of what changes in routing: hosts added or removed, a Rule whose Destination changed, a Middleware added or dropped. Built by running the existing route summary on the current and the new Caddyfile.
- **Who does it:** no competitor found. Closest analogy is a plan step in infrastructure tools. This is Fairway's own idea, listed because the building blocks (`POST /api/routes` with `text`) already exist.
- **Why it matters here:** a text diff of a 400-line Caddyfile with snippets and imports does not tell you that a host now points elsewhere. Moderate value; the text diff is already good.
- **Effort:** small to medium (diff of two `Site[]` structures plus UI in the review dialog).
- **What Caddy exposes:** `/adapt` for the candidate, `/config/apps/http/servers` for the running one. Already used.

### 7. Snippet library for common blocks

- **What:** insert-from-menu blocks in the editor (reverse proxy with health check, Cloudflare DNS challenge `tls` block, security headers, basic auth, redirect, static file server, a named log).
- **Who does it:** CaddyManager (templates), Nginx UI (snippets and templates), jadylc (policy templates), NPM (its whole form UI).
- **Why it matters here:** weak. The owner already has a working Caddyfile and edits it by hand; a snippet menu saves typing but invents no new capability. Keep only if cheap.
- **Effort:** small (static list plus an editor command). A full add-site form is large and duplicates the editor; not recommended.
- **What Caddy exposes:** nothing needed; `/adapt` validates the result.

### 8. Read-only status endpoint and token for dashboards

- **What:** one read-only JSON endpoint (Caddy reachable, hosts up or down, worst certificate severity) behind a static bearer token, for Homepage, Uptime Kuma or a script.
- **Who does it:** caddy/ui (scoped read-only tokens and a Homepage widget), Traefik (API).
- **Why it matters here:** only if the owner already runs a dashboard (**unverified**; ask). It is also a cheap way to get alerts without building candidate 1 (Uptime Kuma can poll it).
- **Effort:** small, but it adds a second credential type next to the single login (ADR 0005), so decide that deliberately.
- **What Caddy exposes:** nothing new; it re-serves data Fairway already holds.

## 4. Things competitors do that Fairway should deliberately not do

| Competitor feature | Seen in | Why Fairway skips it |
|---|---|---|
| Multi-user accounts, roles, permissions | NPM, CaddyManager, Nginx UI, Pangolin | One Owner by design (CONTEXT.md, ADR 0005); roles add a user database and a permission model for nobody |
| Identity provider, SSO, zero-trust access, VPN tunnels | Pangolin | Different product category; Fairway is internal-only and sits next to Caddy |
| Exposing the dashboard publicly | NPM and Traefik docs even warn against it | Fairway is not designed for the internet; the login is a convenience gate, not a hardened edge |
| Certificate request and upload UI, custom certs, ACME issuer forms | NPM, jadylc, Zoraxy, Nginx UI | Caddy obtains and renews certificates itself; Fairway observes (ADR 0003) and the Caddyfile is the source of truth |
| Reading Caddy's certificate store, orphan certificate cleanup | caddy/ui | Needs a storage mount or S3 credentials and an unofficial layout, rejected in ADR 0003 |
| Docker socket discovery, config from labels | Traefik, caddy-docker-proxy, caddy/ui | Mounting the Docker socket gives Fairway root-equivalent power over the NAS; and a generated Caddyfile conflicts with a hand-edited one |
| Multi-instance and cluster mirroring | caddy/ui, CaddyManager, Nginx UI | One Caddy on one NAS; a server picker and credentials per instance is pure overhead |
| Replacing the Caddyfile with a form-built config database | NPM, jadylc, CaddyManager | The mounted Caddyfile stays the single source (ADR 0001); a second source of truth would drift |
| Web terminal, SSH, port scanner, Wake-on-LAN, mDNS scan | Zoraxy | Not about Caddy; a web shell inside a proxy manager is a large attack surface |
| AI assistant and MCP control interface | Nginx UI | Sending configs to a model or giving an agent deploy rights is a privacy and safety decision, not a feature gap |
| Plugin marketplace for the UI itself | Nginx UI, Zoraxy | Third-party code inside a tool that can reload the reverse proxy |
| Firewall, geo block and IP allow-list management in the UI | Zoraxy, NPM access lists | These are Caddyfile directives and plugin config; plugin panels were already ruled out |
| Telemetry or update-check phone-home | caddy/ui checks hourly for newer images by default | Unwanted traffic from a private tool; release notes are enough |

## Sources

- Nginx Proxy Manager: https://github.com/NginxProxyManager/nginx-proxy-manager , https://nginxproxymanager.com/screenshots/ (lists screens only, not their contents)
- Traefik: https://doc.traefik.io/traefik/reference/install-configuration/api-dashboard/ , https://github.com/traefik/traefik
- Caddy: https://caddyserver.com/docs/api , https://caddyserver.com/docs/metrics , https://github.com/caddyserver/caddy (tag v2.11.9: `metrics.go`, `modules/caddyhttp/reverseproxy/metrics.go`, `hosts.go`, `admin.go`)
- caddy/ui: https://github.com/zackwag/caddy-ui , https://zackwag.github.io/caddy-ui/
- CaddyManager: https://github.com/caddymanager/caddymanager
- jadylc/caddyUI: https://github.com/jadylc/caddyUI
- caddy-docker-proxy: https://github.com/lucaslorentz/caddy-docker-proxy
- Zoraxy: https://github.com/tobychui/zoraxy (README, `src/mod/uptime/uptime.go`, `src/mod/statistic`)
- Nginx UI: https://github.com/0xJacky/nginx-ui (README, `internal/sitecheck`, `internal/notification`, `internal/self_check`)
- Pangolin: https://github.com/fosrl/pangolin , https://docs.pangolin.net
- SWAG: https://github.com/linuxserver/docker-swag
- Cloudflare: https://developers.cloudflare.com/analytics/account-and-zone-analytics/zone-analytics/ , https://developers.cloudflare.com/health-checks/

## Limits of this research

- I read READMEs, docs pages and source directory listings. I did not run any of the products or view their screenshots, so UI quality and exact behaviour of alerts and uptime views are taken from their descriptions.
- The Traefik and NPM doc pages fetched were thin (the NPM screenshots page only lists captions); their rows in the matrix rely on the READMEs and general knowledge, partly **unverified**.
- Star counts and release dates are a snapshot of 2026-11-10.
