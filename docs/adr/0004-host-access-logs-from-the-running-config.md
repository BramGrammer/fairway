# Find a host's access log from the running config, and read it from a mounted folder

The Caddyfile can send access logs to any number of files, so Fairway cannot be told one file for everything. It asks Caddy instead: the HTTP servers' per-host logger names say which logger a host uses, and the `logging` section says where that logger writes. Fairway then reads that file from the folder it has mounted read-only (`LOG_DIR`), mapping by file name.

## Why

- The running config is the truth after every reload, including snippets and imports. A setting would drift from the Caddyfile.
- The log folder is already mounted for the Logs page, so no new secret or access is needed.

## Consequences

- Resolution is read on every request and never cached. The live stream re-checks it and ends when the host moves to another file, so the client reconnects.
- Only file writers can be read. stdout, stderr and network writers produce a stated reason, as does a host Caddy does not log.
- A missing file cannot be told apart from a folder that is not mounted, because Fairway cannot see the path inside Caddy's container. The message names the file and the configured path.
- Lines are matched on the host Caddy recorded (no port). Hosts that share a file only see their own lines.
- Rotated files named by Caddy (name plus timestamp) are read when the current file has too few lines. Compressed rotations (`roll_gzip`) are not read.
- Fairway shows what Caddy wrote; redaction is Caddy's job. There is no login, so the tab warns that logs hold visitor addresses and paths.

## Considered

- **A `LOG_FILE` per host in Fairway's settings.** Needs manual upkeep and breaks on every Caddyfile change.
- **Parsing the Caddyfile for `log` blocks.** Misses snippets and global defaults that the adapted config already resolves.
