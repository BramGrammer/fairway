# Fairway

A private web interface for editing the Caddy reverse proxy's configuration and applying it without downtime.

## Language

**Caddyfile**:
The human-written configuration text for the Caddy instance.

**Fairway**:
The web application this project builds. Meant for an internal network; it is not designed to be exposed to the internet.

**Admin API**:
Caddy's own control interface, used by Fairway to validate and reload a Caddyfile.

**Validation**:
Checking that a Caddyfile is acceptable to Caddy without applying it. Always happens before a save or reload.

**Reload**:
Making Caddy run a new Caddyfile in place, with no dropped connections.

**Site**:
One hostname block of the Caddyfile: the hosts it answers for, and everything that happens to a request for them.

**Rule**:
Part of a Site that applies to some requests, such as one path, and sends them to its Destinations. Every Site has at least one.

**Destination**:
Where a Rule finally sends a request: an upstream server, a directory of files, a redirect or a fixed response.

**Middleware**:
Something that acts on a request on its way to a Destination, such as compression, a firewall or a country restriction. Applies to a whole Site or to a single Rule.

**Certificate**:
The TLS identity Caddy presents to visitors of a Site. Obtained and renewed by Caddy itself; Fairway only observes it.

**Access log**:
A record of the requests Caddy handled for a Site, written to a file chosen in the Caddyfile. Distinct from Caddy's runtime log, which records Caddy's own events.

**Revision**:
A saved, timestamped version of the Caddyfile that has been applied. Can be diffed against and rolled back to.

**Original**:
The Caddyfile exactly as it was before Fairway first changed it. Always kept, never pruned.

**Rollback**:
Reloading an earlier Revision as the live Caddyfile.

## Relationships

- A Caddyfile is validated, then reloaded; a successful reload creates a Revision.
- A Site has one or more Rules; each Rule has Middleware and leads to one or more Destinations.
- Fairway never holds an invalid Caddyfile as the live one.
