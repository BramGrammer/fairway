# Changes to the existing Caddy stack

Apply these in Dockge to your Caddy stack before deploying the Editor. Nothing here is applied automatically.

## 1. Create the socket folder on the NAS

```
mkdir -p /path/to/dockge/stacks/caddy/caddy/admin
```

## 2. `compose.yaml`

Remove the published admin port:

```diff
     ports:
-      - "2019:2019"
       - "443:443"
```

Add the socket folder volume:

```diff
       - "./caddy/CaddyFile:/etc/caddy/Caddyfile"
+      - "./caddy/admin:/run/caddy-admin"
```

## 3. Caddyfile global options

Add one line at the top of the existing `{ ... }` block:

```diff
 {
+    admin unix//run/caddy-admin/admin.sock|0660
+
     # Global ACME Contact Email
     email you@example.com
```

To show live per-site traffic on the Routes page, add this next to it (optional):

```diff
+    metrics {
+        per_host
+    }
```

It must be the global `metrics` option. Putting `metrics` inside `servers { }` is the older form and does not give per-host series in current Caddy. `per_host` adds one set of series per configured hostname, which is fine at this size.

Restart the Caddy stack once. This is the last restart needed. After it, the Editor handles reloads.

## 4. Verify

```
ls -l /path/to/dockge/stacks/caddy/caddy/admin/
```

`admin.sock` should exist. If the Editor cannot connect, check the socket's owner and mode first. Caddy runs as root in the official image, so the Editor either runs as root or the mode is widened.

## Optional cleanup

If a site such as `app.example.com` has its own `log` block writing to `access.log` without the roll settings. Remove it and rely on the global `log` block to avoid two writers on one file.
