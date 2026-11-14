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
- **What sends an Alert** (Settings › Alerts): a switch for Caddy not answering, a refused Deploy, an outside edit and a Rollback (off by default), plus recovery messages and the flapping message with its limits.
- **Reviews** (Settings › Alerts): the lowest level of Observation that makes a finished Review send one message: info, notable, urgent (the default) or never. Observations marked as still going on from the last Review do not count. The Event is recorded whatever the level allows an Alert for; the message names the Sites and the most serious Observation and links to the Review when a public address is set.
- **How long a problem must last** (Settings › Monitoring): how long Caddy and upstreams must fail before they count as down. A shorter blip never shows in the history or sends an Alert.
- **Public address** (Settings › General): `PUBLIC_URL` is its default. It makes each message open Fairway when tapped.
- **Which hosts send Alerts:** none do until you switch them on, in the route drawer on the Routes page. A host's switch has a menu to pick what it sends for (its Certificate, the host check, the upstreams it uses) and to snooze it for an hour or a day. An upstream shared by several hosts alerts while any of them is on, and its message names them. Caddy itself, a refused Deploy and an outside edit are not about a host and follow the switches above. A host that leaves the Caddyfile keeps its settings. Muted hosts are still watched: the history and timeline record everything.
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

## Assistant and Reviews

Two optional features use an AI model, and both are off until you choose a model:

- **Assistant:** a chat beside the editor. Ask about the Caddyfile, or ask for a change. A change comes back as a **Proposal**, a difference against what is in the editor, which you accept or reject.
- **Reviews:** a scheduled read of the Access logs that reports **Observations**, such as probing or scanning, in the Reviews tab.

Both need the **Owner's login** ([Login](#login)). Without `AUTH_USER` and a password they stay off and Settings › AI is read-only, because anyone who could reach an open Fairway could otherwise spend your credit and read your Conversations.

### Connect a model

Fairway talks to one endpoint that speaks the OpenAI chat-completions format, with one model for the Assistant and one for Reviews. Set them in **Settings › AI**, or as defaults in `.env`. Settings wins over the environment until you reset it, and is kept in `ai-settings.json` in `DATA_DIR` (mode 0600).

| Endpoint | `AI_BASE_URL` | `AI_API_KEY` |
| --- | --- | --- |
| OpenRouter (the default) | empty | your OpenRouter key |
| OpenAI, or another compatible service | its address, e.g. `https://api.openai.example.com/v1` | its key |
| A local server such as Ollama | e.g. `http://192.0.2.20:11434/v1` | none needed |

- A model name is as the endpoint names it, for example `vendor/model-name` on OpenRouter. **Test connection** checks the address and key; the model fields suggest names from the endpoint's list when it has one.
- **The model must support tool calling.** The Assistant checks its drafts through a tool and a Review reads log lines through one. Not every model behind a compatible endpoint can. **Test tool calling** next to each model asks it to call a test tool and says if it does not. Run it before relying on a model.
- The key is write-only: Settings shows only whether one is set and never the key, and the API never returns it. A key in `.env` is not shown either.
- An address must start with `http://` or `https://`, with no login or query in it, and Fairway does not follow redirects. In a container, `localhost` is the container itself: use the host's address for a local server. An address, interval or model name that is not usable is ignored and the default applies.
- With a local server, the Caddyfile and the digest go only as far as that server. It must be a model good enough for tool calling, which needs capable hardware.

### What leaves your machine

Read this before switching either feature on. Everything below is sent to the endpoint you chose, and so to whoever runs it.

**Assistant, on every turn:**

- the Caddyfile **as it is in the editor** at that moment, unsaved edits included, with recognised secrets replaced by placeholders such as `__FAIRWAY_SECRET_1__` (put back in a Proposal before you see it),
- its Findings, with the same replacement in their text,
- the Conversation so far (your messages and its answers; an earlier Proposal as a one-line note, not its text).

**Assistant, only when it looks something up** (it decides, from your question; the trace under its answer lists each look):

- the **running routes** of one Site (`get_routes`): hosts, what each rule matches, the middleware on it and where it sends the request, with the same secret replacement,
- the **Access log** of one Site for the last 7 days (`get_log_lines`): first a summary (counts per status, path, client address and user agent), and individual lines only for a narrow filter. A line is time, status, method, path without its query string, client address, size and user agent. Headers, cookies and the raw line are never sent.

It is sent nothing else: no Events, no Certificates, no other files.

**Which secrets are recognised.** Fairway reads the text for exactly these, and nothing wider:

- DNS provider credentials: the values in `dns` and `acme_dns` whose setting name contains `token`, `key`, `secret`, `password` or `credential` (identifiers such as `zone_id` are left),
- password hashes in a `basic_auth` block,
- values of `Authorization`, `Proxy-Authorization` and `Cookie` headers, and of any header whose name contains `key`, `token` or `secret`, in `header`, `header_up`, `header_down` and `request_header`.

**The recognition does not cover everything.** Not recognised, so sent as written: a secret in any other directive or plugin (for example `forward_auth`, ACME account keys, a login in an upstream address such as `https://user:password@app.example.test`, a `respond` body); a `basic_auth` written on one line; credentials in headers with other names (`X-Auth`, `X-Password`); and anything in a heredoc. Values already written as a placeholder (`{env.X}`) are left alone, as they should be. The Finding "a secret is written in the Caddyfile" is the backstop for the cases it knows, and it does not know the rest. **Keep secrets out of the Caddyfile with `{env.X}` placeholders**, and set the variable in Caddy's environment.

**Review:**

- **The digest**, one per Site with an Access log, built by Fairway from the logs and not the lines: request totals and the split by status code, per hour; the 15 clients with the most requests and the 15 with the highest share of 4xx answers (at least 10 requests), with their addresses; the 15 paths most often answered 401, 403 or 404; unusual methods; the 15 most common user agents; and which log files and parts of the period were read. Query strings are cut and paths and user agents are shortened.
- **The Site summary**: each Site's hosts, its Rules' matchers (such as paths), Middleware names and Destination kinds. Not the Caddyfile text, upstream addresses or secrets.
- **The previous Review's Observations** (level, Sites, title, explanation), so ongoing scanning is not reported as new.
- **Log lines, only when the model asks for them** (up to 8 requests of at most 100 lines each, for one Site and the Review's period): time, status, method, host, path, **client address**, duration, size and user agent. The query string is removed, headers and the raw line are never included. **Client IP addresses are sent as they are**; so are paths, hosts and user agents, which can still hold a token or a name if an app puts one there.

**What Fairway keeps.** In `DATA_DIR`: `conversations.json` (mode 0600) and `reviews.json` (mode 0600), each for 30 days. A stored Conversation holds the masked text, so no recognised secret. It does hold your own messages, and a secret you typed that is not in the Caddyfile is stored, and was sent, as you typed it. A Review keeps its Observations, which can name client addresses and paths, the period, the model, the token usage and which lines were requested, not the lines.

### What the AI cannot do

- **The Assistant never reloads and never deploys.** A Proposal only changes the editor when you accept it. You then Deploy through the usual Validation, confirmation of warnings and Reload ([How a save works](#how-a-save-works)). Its other tools only read. It is also a model: a Proposal can be valid and still be wrong (the right syntax on the wrong Site), so read the difference.
- **A Review is read-only.** It never touches the Caddyfile, and the only thing it can write is its own record of Observations.
- **Log text is written by outsiders** and Fairway tells the model to treat it as data. A model can still be talked into things. For a Review the worst a successful injection can do is hide an Observation or invent one, so do not rely on a Review as your only alarm. The Assistant can read log text too and can propose changes, so a planted line could try to steer a Proposal; that is one more reason to read the difference before you accept it.

### How it behaves

- **Validation of drafts.** Before a Proposal is shown it goes through Validation and the model gets the Findings back to correct itself, three attempts at most. After that it is shown anyway, marked as not valid (the button reads "Accept anyway"), because a near miss can still help. One Proposal is pending at a time; a follow-up message revises it, and if the editor changes underneath it is marked outdated and cannot be accepted.
- **Limits per Assistant turn:** 6 edit tool calls, 5 lookups (60 log lines in all), and an answer of at most 4,000 tokens. The Caddyfile may be at most 200,000 characters, and a Conversation at most 80 messages or 60,000 characters before you must start a new one. At most 200 Conversations are kept.
- **Limits per Review:** 8 requests for log lines (a summary, or at most 50 lines each and 150 in all), an answer of at most 4,000 tokens, 256 MiB of log read (the oldest part of the period is dropped first) and 5 minutes in all.
- **Usage.** Tokens read and written are shown under each Assistant answer and as a Conversation total, and in the Tokens column and the details of each Review. Fairway shows tokens, not money; the endpoint's own dashboard has the cost.
- **Schedule** (Settings › AI › Reviews run): off, every 6 hours, every 12 hours, every 24 hours (the default) or weekly, and **Review now** in the Reviews tab. It runs inside Fairway, about 2 minutes after a start, and needs a model for Reviews and a login. A Review covers the time since the previous successful one (the last 24 hours for the first), for at most 31 days. Fairway keeps no copy of the logs, so what Caddy has rotated away, or beyond the read limit, or a Site without a readable Access log, is listed in the Review under "What could not be seen" and not judged.
- **Alerts.** A Review that finds something new at or above the level in **Settings › Alerts** (default urgent) records one Event, which sends one Alert when topics are set up (see [History and alerts](#history-and-alerts)).
- **Failure.** A failed Review is listed with its reason. A scheduled one is tried once more an hour later; one that you started is not retried. The second failure in a row records an Event (an Alert too, unless you switched off the "Reviews keep failing" message), so a revoked key does not go unnoticed. The next successful Review covers the missed time.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `ADMIN_SOCKET` | `/run/caddy-admin/admin.sock` | Caddy admin API socket |
| `CADDYFILE_PATH` | `/caddyfile/Caddyfile` | The mounted Caddyfile |
| `DATA_DIR` | `/data` | Original, Revisions, the login secret, the traffic history (`metrics.json`) and the event history (`events.json`) the alert settings you changed (`alert-settings.json`), the AI settings you changed (`ai-settings.json`), and the Conversations and Reviews (`conversations.json`, `reviews.json`). Mount it as a volume to keep them across restarts |
| `LOG_DIR`, `LOG_FILE` | `/var/log/caddy`, `access.log` | Where Caddy writes its JSON log. The TLS tab's last issuance error needs Caddy's default logger (not only access logs) to write here. |
| `MAX_REVISIONS` | `50` | Deployed Revisions kept |
| `AUTH_USER`, `AUTH_PASSWORD` | unset | The Owner's login, see [Login](#login). Both, or neither |
| `AUTH_PASSWORD_HASH` | unset | A scrypt hash instead of `AUTH_PASSWORD`; wins when both are set |
| `TRUST_PROXY` | unset | Comma separated proxy addresses or CIDR ranges whose `X-Forwarded-*` headers are believed |
| `NTFY_URL` | unset | ntfy topic address(es), comma separated, for Alerts, see [History and alerts](#history-and-alerts). Treat as a secret |
| `NTFY_TOKEN` | unset | Access token for the topic, if it needs a login |
| `AI_BASE_URL` | `https://openrouter.ai/api/v1` | Address of an OpenAI-compatible model endpoint (OpenRouter, OpenAI, or a local server). Only a default: Settings › AI overrides it. See [Assistant and Reviews](#assistant-and-reviews) |
| `AI_API_KEY` | unset | Key for that endpoint (a local server needs none). Treat as a secret; Settings › AI can replace it and never shows it |
| `AI_ASSISTANT_MODEL` | unset | Model the Assistant uses, as the endpoint names it. It must support tool calling. Without it the Assistant is off. Only a default: Settings › AI overrides it |
| `AI_REVIEW_MODEL` | unset | Model Reviews use, with the same rules; without it Reviews are off |
| `AI_REVIEW_INTERVAL` | `24h` | How often a Review runs by itself: `off`, `6h`, `12h`, `24h` or `weekly`. It only runs with a Reviews model and a login. Only a default: Settings › AI overrides it |
| `PUBLIC_URL` | unset | Fairway's own address, makes each Alert open Fairway when tapped |
| `HOST_CHECK` | unset | `1` turns on the request-per-host check; needs `TLS_PROBE_ADDR` |
| `TLS_PROBE_ADDR` | unset | Caddy's HTTPS address as the editor reaches it, `host` or `host:port` (port defaults to 443), e.g. `192.0.2.10:443`. Turns on Certificate probing in the TLS tab, see below |
