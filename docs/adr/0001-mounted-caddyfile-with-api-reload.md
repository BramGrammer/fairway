# Mount the Caddyfile and reload through the admin API

The Editor mounts the live Caddyfile read-write and writes edits to it in place. It applies them to the running Caddy through the admin API (`/adapt` to validate, `/load` to reload) rather than managing configuration through the API alone.

## Why

- The admin API cannot return the original Caddyfile text, only adapted JSON, so an API-only Editor would have to hold its own copy as the source of truth.
- A config loaded through the API is not written back to the Caddyfile. Caddy starts from the file, so a restart would silently revert API-only changes unless Caddy were started with `--resume`, which changes how the existing stack runs.
- Mounting keeps the file as the single source of truth: restarts, hand edits and the Editor all agree.

## Consequences

- The Caddyfile is mounted into Caddy as a single file, so the Editor must write in place (truncate and write) to keep the same inode. It never saves to a temporary file and renames.
- The Editor mounts only that file, not its folder, which also holds Caddy's data and config.
- Every edit follows the same order: validate, back up, write, load. A failed load restores the previous file.
- The Original and the last 50 deployed Revisions are stored in the Editor's own volume, outside the mounted file.

## Considered

- **API only, no mount.** Rejected for the reasons above.
- **API only with `--resume`.** Rejected: it changes the existing Caddy stack's start command and still cannot return the original text.
