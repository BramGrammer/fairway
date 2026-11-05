# Caddy Editor

A private web editor for the Caddyfile. Edit it in the browser, validate it against the running Caddy, and hot reload with no downtime. Keeps history with diff and rollback, and shows Caddy's logs.

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

Editor: http://127.0.0.1:3000. The dev Caddy serves http://127.0.0.1:8080 and :8081. Change the response text in the editor, deploy, and watch `:8080` change with no restart. `npm run dev:down` stops it, `npm run dev:reset` also wipes its state.

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

First apply the changes to the Caddy stack in [docs/caddy-stack-changes.md](docs/caddy-stack-changes.md) (admin socket folder).

Then in Dockge create a stack from this folder, copy `.env.example` to `.env`, and set `CADDY_STACK_DIR`.

| Profile (`COMPOSE_PROFILES`) | What you get |
| --- | --- |
| `local` (default) | Editor on `127.0.0.1:3000` of the NAS. Test through `ssh -L 3000:127.0.0.1:3000 your-nas`. No authentication. |
| `tailscale` | Tailscale sidecar at `https://caddy-editor.<tailnet>.ts.net`, no published port, only `TS_ALLOWED_LOGIN` is let in. Needs `TS_AUTHKEY` (tagged `tag:caddy-editor`) and an ACL restricting that tag to your own devices. |

Switching is a one-line change to `COMPOSE_PROFILES`, then Deploy.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `ADMIN_SOCKET` | `/run/caddy-admin/admin.sock` | Caddy admin API socket |
| `CADDYFILE_PATH` | `/caddyfile/Caddyfile` | The mounted Caddyfile |
| `DATA_DIR` | `/data` | Original and Revisions |
| `LOG_DIR`, `LOG_FILE` | `/var/log/caddy`, `access.log` | Where Caddy writes its JSON log |
| `MAX_REVISIONS` | `50` | Deployed Revisions kept |
| `REQUIRE_TAILSCALE_LOGIN` | unset | Only this `Tailscale-User-Login` may use the editor |
