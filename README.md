# Fairway

A private web interface for your Caddy reverse proxy. Edit the Caddyfile in the browser, validate it against the running Caddy, and hot reload with no downtime. See every site, handler and destination as a live traffic graph. Keeps history with diff and rollback, and shows Caddy's logs.

Terminology is in [CONTEXT.md](CONTEXT.md). Design decisions are in [docs/adr](docs/adr).

## How a save works

1. Validate with Caddy's admin API (`/adapt`), on the real binary with all its plugins.
2. Back up: an outside edit is snapshotted first; the Original is kept forever.
3. Write the Caddyfile in place (same inode, so Caddy's single-file mount stays valid).
4. Reload with `/load`. If Caddy refuses, the previous file is restored automatically.
5. Only a successful reload becomes a Revision (last 50 kept).

## Try it locally

```
npm install
npm run dev:up      # throwaway Caddy + editor in Docker
```

The dev Caddy is built from `dev/caddy/Dockerfile`, the same plugin build as production (Cloudflare DNS, Coraza, GeoIP, rate limit, cache, S3 storage, brotli). That is what lets the dev editor validate a real Caddyfile; stock `caddy:2` rejects directives like `geo_ip`. The first `dev:up` compiles it and takes a few minutes; later runs reuse the cached image.

Validate, Format and Routes only read your Caddyfile (`/adapt` never applies it), so they are safe with a real one. Do not **Deploy** a production Caddyfile in dev: it would try to load real domains, certificates and storage.

Fairway: http://127.0.0.1:3000, signed in with the throwaway login `dev` / `dev` from `dev/compose.yaml` (delete the two `AUTH_*` lines there to see the open mode). The dev Caddy serves http://127.0.0.1:8080 and :8081. Change the response text in the editor, deploy, and watch `:8080` change with no restart. `npm run dev:down` stops it, `npm run dev:reset` also wipes its state.

The sample Caddyfile (`dev/Caddyfile.sample`) writes three logs into `dev/run/logs`, which Fairway reads: `access-public.log` (hosts on :8080, with `api_key` and `token` query values redacted), `access-int.log` (hosts on :8081, no redaction) and the default `access.log` (runtime messages plus hosts without their own named log). `dev:up` only copies the sample to `dev/run/Caddyfile` when that file does not exist, so after the sample changes run `npm run dev:reset` (or delete `dev/run/Caddyfile`) to pick it up. Send test requests with a Host header:

```
curl -H 'Host: app.example.test' 'http://127.0.0.1:8080/?api_key=secret&x=1'    # public log, api_key redacted
curl -H 'Host: admin.example.test' 'http://127.0.0.1:8081/?token=abc'           # internal log, not redacted
curl -H 'Host: plain.example.test' 'http://127.0.0.1:8080/'                     # default access.log
curl -H 'Host: quiet.example.test' 'http://127.0.0.1:8080/'                     # no log block: default access.log without a port in Host
curl -H 'Host: quiet.example.test:8080' 'http://127.0.0.1:8080/'                # what a browser sends: skipped, not logged
```

Frontend work with hot reload: keep the dev stack running and start `npm run dev:web` (Vite on http://localhost:5173, proxying `/api` to the editor on :3000).

```
npm test            # pipeline and log tests against a fake Caddy admin socket
npm run typecheck   # server and web
```

## Frontend

`web/` is a Vite + React app using shadcn/ui (Base UI, `nova` preset). Add components only through the CLI, from `web/`:

```
npx shadcn@latest add <component>
```

The editor is CodeMirror 6 with a Caddyfile mode: tab indentation (Tab and Shift-Tab), brace-aware auto-indent, bracket closing, and Cmd/Ctrl+S to review and deploy.

## Deploy on the NAS

Releases publish the image to `ghcr.io/bramgrammer/fairway` (see [Releases](#releases)). The NAS only pulls it, so no source code is needed there.

First apply the changes to the Caddy stack in [docs/caddy-stack-changes.md](docs/caddy-stack-changes.md) (admin socket folder).

Then in Dockge create a stack named `fairway` and put these in its folder:

- `compose.yaml` from this repo
- `.env`, copied from `.env.example`, with `CADDY_STACK_DIR` set

| Profile (`COMPOSE_PROFILES`) | What you get |
| --- | --- |
| `local` (default) | Fairway on `127.0.0.1:3000` of the NAS. Test through `ssh -L 3000:127.0.0.1:3000 your-nas`. Set `AUTH_USER` and a password to require a login, see [Login](#login). |

**Updating:** pull the new image and redeploy. In Dockge press **Update** on the stack (or `docker compose pull`, then Deploy). Set `FAIRWAY_TAG` to a version such as `0.2.0` to pin one instead of `latest`.

The package must be public so the NAS can pull it without logging in. After the first build, open the package on GitHub, then Package settings, Change visibility, Public.

## Releases

Versions, the changelog and the image are produced by [release-please](https://github.com/googleapis/release-please) from [Conventional Commits](https://www.conventionalcommits.org). Nothing is published when you merge to `main`; it only updates a release pull request.

1. Write commit messages as `feat: ...` (minor bump), `fix: ...` (patch), or `feat!: ...` / a `BREAKING CHANGE:` footer (major; while the version is below 1.0 a breaking change bumps the minor). `docs:`, `chore:`, `ci:`, `style:` and `test:` do not trigger a release.
2. Merging to `main` opens or updates a pull request named `chore(main): release X.Y.Z`. It bumps the version in `package.json`, `package-lock.json` and `web/package.json`, and adds the new section to [CHANGELOG.md](CHANGELOG.md).
3. Merge that pull request when you want to release. This tags `vX.Y.Z`, creates the GitHub Release with the changelog as its notes, and publishes the image as `X.Y.Z`, `X.Y` and `latest`.

CI (typecheck, lint, tests) runs on every push and pull request. The release pull request itself is made with the built-in token, so GitHub does not run CI on it; it only changes version files and the changelog. The repository setting "Allow GitHub Actions to create and approve pull requests" must be on.

## TLS probing

Caddy's admin API reports configuration, not certificates. When `TLS_PROBE_ADDR` is set, opening a host's TLS tab makes a TLS handshake to that address with the host's name and shows the Certificate actually served: issuer, expiry and the names it covers. Results are cached for 10 minutes; the Re-check button probes again.

- Amber: under 21 days left (Caddy renews about 30 days out, so a renewal is likely failing), or a Certificate for a different name (Caddy's fallback Certificate).
- Red: expired, under 7 days left, or the handshake failed.
- On-demand hosts, HTTP-only hosts and hosts covered only by a wildcard are never probed. A handshake can trigger issuance.

The address must reach Caddy directly, for example its LAN address. Probing the public name of a host behind a CDN proxy returns the proxy's Certificate, not Caddy's. Without the variable the tab shows what the config says and how to enable probing. See [ADR 0003](docs/adr/0003-tls-visibility-by-probing.md).

## History and alerts

Fairway watches these **Subjects** and keeps a history of their **State** (ok, warning or down) for 30 days in `events.json` in `DATA_DIR`:

- Caddy itself (does the admin API answer?),
- each upstream that has an active health check in the Caddyfile (Caddy reports health only for those),
- each Certificate the TLS probe checks, see [TLS probing](#tls-probing),
- each host, when the opt-in host check is on (below).

A State changes only after it has held for a while: about 15 seconds for Caddy and one minute for an upstream. A short blip never shows. The route drawer shows a timeline strip per host, the routes table a compact one, and the Events tab lists everything. A stretch in which Fairway was not running shows as unknown, never as down.

Alerts are push messages through [ntfy](https://ntfy.sh). Set `NTFY_URL` to the full address of a topic (for example `https://ntfy.example.test/fairway`; several can be separated by commas) and, if the topic needs a login, `NTFY_TOKEN`. Fairway POSTs the message text with a title, a priority (high for something down or a refused Deploy) and an emoji tag.

These variables are the defaults. **Settings › Alerts** changes them without a restart and keeps your changes in `alert-settings.json` in `DATA_DIR`, where they win until you reset them:

- **Topics:** add more, each with its own token, switch each on or off and send a test to one. Topics from the environment can be switched off but not edited or removed. Addresses and tokens are never shown again after you save them.
- **What sends an Alert:** a switch for each kind of Subject, for a refused Deploy, an outside edit, a Rollback (off by default), for recovery messages and for the flapping message.
- **Timing:** how long Caddy and upstreams must fail before they count as down, and the flapping limits.
- **Public address:** `PUBLIC_URL` is its default.
- Adding, changing or removing a topic address or token needs login (see [Login](#login)); without it only the switches, the timing and switching topics on or off can be changed. Anyone who can reach an open Fairway could otherwise point its requests anywhere.

- Sent for: a Certificate turning amber or red, an upstream or Caddy going down, the recovery of each, a Deploy that Caddy refused, and a Caddyfile that was changed outside Fairway. A Rollback only appears in the history.
- Each bad State is sent once. A Subject that changes State more than 4 times in an hour sends one `flapping` message and is held until it has been stable for 30 minutes.
- A failed delivery is retried after 10 seconds, 1 minute and 5 minutes, then marked "not delivered" in the Events tab. Nothing is queued.
- `PUBLIC_URL` makes each message open Fairway when tapped. The topic address and the token are never shown in the interface; use **Send test** (in Settings or the Events tab) to check them.
- With `HOST_CHECK=1` (and `TLS_PROBE_ADDR`), Fairway also requests `/` of each probed host every 5 minutes through Caddy and counts a connection error, a timeout of 10 seconds, or a 502, 503 or 504 as down (two in a row). Other statuses count as up. This catches an app that fails behind a proxy with no health check. It sends real requests to your hosts, so it is off by default. See [ADR 0006](docs/adr/0006-events-and-alerts-from-one-log.md).

## Login

Fairway has one **Owner**. Set `AUTH_USER` and either `AUTH_PASSWORD` or `AUTH_PASSWORD_HASH` in `.env` and every page and API route asks for that login (only the sign-in page itself is public). Sessions last 12 hours since the last activity and at most 7 days; changing the password or hash signs everyone out. Failed sign-ins are answered more and more slowly (up to 5 seconds) but never lock you out.

- With neither set, Fairway runs open, logs a warning and shows a red "No authentication" notice. Fairway is meant for an internal network, so restrict who can reach it there.
- Setting only one of the username and the password is a startup error.
- A hash keeps the password out of `.env`. Make one with `node -e "import('./dist/server/auth.js').then(async m => console.log(await m.hashPassword(process.argv[1])))" 'your password'` inside the container. The hash contains `$` characters, so single-quote it (or double each `$`) in `.env` and in a Compose file. If both are set, the hash wins.
- Behind Caddy, set `TRUST_PROXY` to Caddy's address (or range). Fairway then reads the visitor's address from `X-Forwarded-For`, and treats the connection as HTTPS when Caddy says so (which marks the session cookie Secure). Without it those headers are ignored, so a client cannot fake its address. Caddy's `reverse_proxy` already replaces these headers from clients it does not trust.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `ADMIN_SOCKET` | `/run/caddy-admin/admin.sock` | Caddy admin API socket |
| `CADDYFILE_PATH` | `/caddyfile/Caddyfile` | The mounted Caddyfile |
| `DATA_DIR` | `/data` | Original, Revisions, the login secret, the traffic history (`metrics.json`) and the event history (`events.json`) and the alert settings you changed (`alert-settings.json`). Mount it as a volume to keep them across restarts |
| `LOG_DIR`, `LOG_FILE` | `/var/log/caddy`, `access.log` | Where Caddy writes its JSON log. The TLS tab's last issuance error needs Caddy's default logger (not only access logs) to write here. |
| `MAX_REVISIONS` | `50` | Deployed Revisions kept |
| `AUTH_USER`, `AUTH_PASSWORD` | unset | The Owner's login, see [Login](#login). Both, or neither |
| `AUTH_PASSWORD_HASH` | unset | A scrypt hash instead of `AUTH_PASSWORD`; wins when both are set |
| `TRUST_PROXY` | unset | Comma separated proxy addresses or CIDR ranges whose `X-Forwarded-*` headers are believed |
| `NTFY_URL` | unset | ntfy topic address(es), comma separated, for Alerts, see [History and alerts](#history-and-alerts). Treat as a secret |
| `NTFY_TOKEN` | unset | Access token for the topic, if it needs a login |
| `PUBLIC_URL` | unset | Fairway's own address, makes each Alert open Fairway when tapped |
| `HOST_CHECK` | unset | `1` turns on the request-per-host check; needs `TLS_PROBE_ADDR` |
| `TLS_PROBE_ADDR` | unset | Caddy's HTTPS address as the editor reaches it, `host` or `host:port` (port defaults to 443), e.g. `192.0.2.10:443`. Turns on Certificate probing in the TLS tab, see below |
