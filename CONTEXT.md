# Caddy Editor

A private web interface for editing the Caddy reverse proxy's configuration and applying it without downtime.

## Language

**Caddyfile**:
The human-written configuration text for the Caddy instance.

**Editor**:
The web application this project builds. Reachable only from the owner's tailnet.

**Admin API**:
Caddy's own control interface, used by the Editor to validate and reload a Caddyfile.

**Validation**:
Checking that a Caddyfile is acceptable to Caddy without applying it. Always happens before a save or reload.

**Reload**:
Making Caddy run a new Caddyfile in place, with no dropped connections.

**Revision**:
A saved, timestamped version of the Caddyfile that has been applied. Can be diffed against and rolled back to.

**Original**:
The Caddyfile exactly as it was before the Editor first changed it. Always kept, never pruned.

**Rollback**:
Reloading an earlier Revision as the live Caddyfile.

## Relationships

- A Caddyfile is validated, then reloaded; a successful reload creates a Revision.
- The Editor never holds an invalid Caddyfile as the live one.
