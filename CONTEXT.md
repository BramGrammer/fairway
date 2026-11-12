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

**Finding**:
A message about a Caddyfile that Validation or Fairway's own rules produce, with a level (error or warning) and, when known, the line it belongs to. Caddy's own errors and warnings and Fairway's rules are all Findings. A Finding never stops a Reload by itself; only Caddy refusing the Caddyfile does.

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

**Owner**:
The single person who signs in to Fairway. There are no other users or roles. Their username and password come from Fairway's environment.

**Session**:
The period during which the Owner is signed in. It ends when they sign out, after a stretch of inactivity, or after a fixed maximum.

**Subject**:
Something Fairway watches and gives a State to: a Site's Certificate, an upstream, how a host answers requests, or Caddy itself.

**State**:
The condition of a Subject once it has held long enough to count (ok, warning or down). A brief blip is not a State.

**Event**:
A recorded change of a Subject's State, or a one-shot occurrence such as a failed deploy. Events make up the history.

**Alert**:
The message Fairway sends to the Owner because of an Event.

**Gap**:
A period in which Fairway was not watching. Shown in the history as unknown, never as down, and never alerted.

**Revision**:
A saved, timestamped version of the Caddyfile that has been applied. Can be diffed against and rolled back to.

**Original**:
The Caddyfile exactly as it was before Fairway first changed it. Always kept, never pruned.

**Rollback**:
Reloading an earlier Revision as the live Caddyfile.

**Assistant**:
The AI chat beside the editor. It answers questions about the Caddyfile and offers Proposals; it never reloads.

**Conversation**:
One chat with the Assistant, kept for a limited time. It can be continued later; the Assistant always works from what is in the editor now, not from what it was when the Conversation began.

**Proposal**:
A changed Caddyfile the Assistant offers, shown as a difference against what is in the editor. The Owner accepts or rejects it; accepting only changes the editor.

**Review**:
One scheduled read of the Access logs by an AI model, looking for requests that deserve the Owner's attention, such as probing or scanning.

**Observation**:
One notable thing a Review reports. Distinct from a Finding, which is about a Caddyfile.

## Relationships

- Validating a Caddyfile gives zero or more Findings; the Owner must confirm a Reload that has warnings.
- A Caddyfile is validated, then reloaded; a successful reload creates a Revision.
- A Site has one or more Rules; each Rule has Middleware and leads to one or more Destinations.
- A Subject has one State at a time; each change of State is an Event, and some Events cause an Alert.
- Events that are not State changes (a failed deploy, an outside edit) have no recovery.
- Fairway never holds an invalid Caddyfile as the live one.
- An accepted Proposal goes through Validation and Reload like any other edit.
- A Review gives zero or more Observations, each with a level (info, notable or urgent). A Review with an Observation at or above the level the Owner chose records one Event.
- A Review never changes the Caddyfile.
