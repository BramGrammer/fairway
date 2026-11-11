# Alert settings can be changed in the interface; the environment is the base

The Owner can change where Alerts go, what sends one and how long things must hold from Settings. The environment (`NTFY_URL`, `NTFY_TOKEN`, `PUBLIC_URL`) gives the defaults, and what the Owner changes is kept in `alert-settings.json` in `DATA_DIR` and wins until it is reset. This replaces the "environment only" part of [ADR 0006](0006-events-and-alerts-from-one-log.md); the login in [ADR 0005](0005-single-owner-login-from-the-environment.md) stays environment-only.

## Why

- Alerts are tuned by trial: a hold time that is too short, a Rollback message that is noise. Editing a file and restarting the container for each try is the wrong loop for a NAS owner.
- Several topics (a phone, a tablet, a second ntfy server) do not fit one environment variable well, and tokens differ per topic.
- No second service is needed: Fairway already writes its own state files to `DATA_DIR`.

## Consequences

- **Precedence.** A value saved in the interface hides the environment's value until it is reset; the interface shows which values are changed and offers a reset. Topics are a list, so those from `NTFY_URL` stay as locked entries that can be switched off but not removed or edited, and topics added in the interface sit next to them.
- **Secrets are write-only.** Addresses and tokens are never returned by the API, not even to the Owner. The interface shows a topic's host name, and whether a token is set. They sit in plaintext in `alert-settings.json` (mode 0600), the same trust as the login secret in the same directory.
- **Login is required to change where Alerts go.** With no login, anyone who can reach the page could aim Fairway's outbound requests anywhere. Without a login the topic addresses and tokens cannot be added, changed or removed; the switches and timing can, and so can switching a topic off.
- The settings apply from the next reading, with no restart. Exposed are the hold times for Caddy and upstreams (under Monitoring, since they decide what the history records as down, not only what alerts), the public address (under General, since it describes this instance), and under Alerts the topics, the switches for Caddy, a refused Deploy, an outside edit, a Rollback, recovery and flapping, and the flapping limits. Certificates, upstreams and the host check have no global switch: they are chosen per host. The Certificate, host-check and Gap thresholds stay fixed in code.
- **Hosts are opt-in.** The Owner runs many services they do not care about, so a host sends no Alerts until it is switched on in the route drawer, with a choice of kinds (Certificate, host check, upstreams) and a snooze. The switch only gates the push message: the host is still watched and recorded. Upstreams are shared between hosts, so an upstream alerts while any host that uses it is on, which needs the host-to-upstream map of the running config. The map is refreshed every 15 seconds and after a Deploy; an upstream that is not in it sends nothing. The list is kept by host name, so a host that leaves the Caddyfile and returns is still set up.
- A change of a value in the environment is hidden by a saved override, which is why the interface marks overridden values.

## Considered

- **Environment wins, the interface is read-only.** Simplest and never surprising, but it keeps the restart loop and cannot hold several topics with their own tokens.
- **Fully replace the environment's topics once anything is saved.** Predictable, but a typo in the interface would silently drop the topic that is known to work.
- **Showing the address with a reveal button.** Convenient, but it puts the secret into the browser and its history for no gain; replace and test cover the real needs.
