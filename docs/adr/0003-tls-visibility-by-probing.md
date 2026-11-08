# Show TLS status by probing Caddy, not by asking its API

Caddy's admin API reports configuration but not certificates: no expiry, no renewal state, no issuance errors. Fairway therefore combines two sources: the adapted config (which Sites are managed, which issuer and challenge) and a TLS handshake to Caddy's own port 443 with the Site's hostname, which shows the certificate visitors really get.

## Why

- A probe needs no extra secrets and no shared volume, and it reflects what is served rather than what is stored.
- Reading the certificate store would tie Fairway to a storage module's key layout and, with S3 storage, to bucket credentials.
- The events system only pushes. Using it would need a handler inside Caddy and a place to keep the history.

## Consequences

- The probe must reach Caddy directly (`TLS_PROBE_ADDR`, e.g. the NAS's LAN address). Probing the public name of a Cloudflare-proxied host returns Cloudflare's certificate, not Caddy's. Without the setting, Fairway shows the config-derived information and explains how to enable probing.
- On-demand TLS hosts are never probed, because a handshake can trigger issuance. HTTP-only Sites and Sites covered only by a wildcard are skipped.
- A certificate for a different name than the one probed means Caddy served its fallback certificate. Fairway reports that as a problem.
- Caddy renews about 30 days before expiry, so a certificate with fewer than 21 days left is treated as a failed renewal.
- Issuance and renewal errors exist only in Caddy's logs. Fairway shows the last one on a best-effort basis, read from the log it already tails.

## Considered

- **Reading the certificate store (filesystem or S3).** Gives the exact issuer directory, but needs credentials or a mount and relies on an unofficial layout.
- **Caddy's events app.** Push-only, no history to query.

## Issuance errors from the log

Fairway scans the tail of the log it already reads for lines whose logger starts with `tls.` (`tls.obtain`, `tls.renew`, `tls.issuance.acme`), at level `error`, with the host in `identifier`. The newest one per host is shown with its age, and a later "certificate obtained/renewed successfully" line for the host clears it.

- This works only when Caddy's default logger writes to the tailed file, as in a global `log { output file ... }` block. With per-site named loggers or the default stderr output, the runtime lines are not in the file and the tab shows nothing. That is indistinguishable from "no errors", so the absence of an error is not proof of a healthy Certificate.
- Only the last 5000 lines are searched, so an error older than that is not found.
- Status: the line shape comes from Caddy's documented JSON logging and certmagic's log calls. It has not been verified against a real log; the tests use synthetic lines. Verify against a real failed issuance before relying on it.
