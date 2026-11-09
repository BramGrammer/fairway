# One Owner, signed in from the environment, with a signed cookie

Fairway used to let anyone through, or, with the Tailscale profile, anyone whose `Tailscale-User-Login` header matched a setting. That header was only as trustworthy as whatever set it. Fairway now has its own login for a single **Owner**: `AUTH_USER` plus `AUTH_PASSWORD` or `AUTH_PASSWORD_HASH` in the environment, and a **Session** kept in a signed cookie. The Tailscale header check and compose profile are removed.

## Why

- Fairway can reload the whole proxy, so it needs to know who is using it without relying on a header another component sets.
- Environment credentials need no setup screen, no database and no first-visitor race. A hash option keeps the password out of `.env`.
- A stateless signed cookie needs no session store. The signing secret lives in `DATA_DIR`, so restarts keep the Owner signed in, and the credential is part of what is signed, so changing it signs everyone out.
- Fairway is meant for an internal network. The login is a second layer on top of restricting access at the network layer (Caddy, Docker), not the only one.

## Consequences

- With no credentials set Fairway still runs open, with a startup warning and a red notice, so existing deployments keep working. Only one of username and password set is a startup error.
- A session lasts 12 hours since last activity and at most 7 days. Logging out only clears the cookie; revoking every session means changing the credential.
- Failed sign-ins are answered with a growing delay per source address, plus a mild global slowdown. There is no lockout, so a device on the LAN cannot lock the Owner out.
- The source address is the socket address. Behind Caddy, `TRUST_PROXY` lists the proxy's address so `X-Forwarded-For` and `X-Forwarded-Proto` are believed from it and from nowhere else. Caddy's `reverse_proxy` replaces those headers from clients it does not trust.
- Mutating endpoints take JSON and the cookie is `SameSite=Strict`, which is the protection against cross-site requests. The cookie is `Secure` only when the connection is HTTPS.
- A session that ends while the Owner has unsaved Caddyfile text loses that text; the app returns to the login screen.
- There is one account and no roles. A settings page with other ways to sign in is possible later; nothing here prevents it.

## Considered

- **Keeping the Tailscale identity header.** Rejected: its trust depends on the sidecar, not on Fairway.
- **Server-side sessions.** Allows real logout and revocation, but adds a store to keep, for one user.
- **A first-run setup screen.** Rejected: it lets the first visitor claim Fairway.
- **No login, network layer only.** Still the behaviour when nothing is configured, but not what the Owner wants by default.
