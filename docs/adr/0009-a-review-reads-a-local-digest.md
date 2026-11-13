# A Review reads a local digest, with redacted lines on request

A Review is a scheduled read of the Access logs by an AI model, looking for requests that deserve the Owner's attention. Fairway does not send the logs. It summarises them itself into a digest per Site and sends that; the model can then ask for a filtered, redacted set of lines through a tool when the digest is not enough. A Review can only read, and what it returns is a fixed structure of Observations.

## Why

- Access logs hold visitor addresses, full request paths and sometimes tokens in query strings. Sending them whole to an outside provider every day is more than the question needs.
- The cost of a digest does not grow with traffic, so a Review still works, and costs the same, on a busy day.
- **Log text is written by attackers.** A path or a user agent can say "ignore your instructions". The model reads it, so the design assumes it can be talked into something, and limits what that something can be.

## Consequences

- **The digest** holds, per Site: request totals and the split by status code per hour, the top clients by request count and by share of 4xx responses, the top paths answered with 401, 403 or 404, unusual methods, and the top user agents. The model also gets the previous Review's Observations, not its totals, so it can tell what is new. The model only sees what the digest was built to surface; the tool covers the rest.
- **The tool returns parsed fields only**: time, status, method, host, path, client address, duration, size and user agent. Query-string values are stripped, headers are never included, and the raw line is never returned. It filters on host, time range, status, path prefix and client, with a limit on rows per call and on calls per Review. Client addresses are sent as they are, since a Review that cannot name an address cannot say anything useful about probing.
- **The model also gets the Site summary** Fairway already derives (hosts, Rules, Middleware names, Destination types), not the Caddyfile text, so it can tell probing that a firewall turned away from probing that reached an upstream.
- **A Review cannot change anything.** It has no tool that writes, and never touches the Caddyfile. A successful injection can hide an Observation or invent one, and nothing more. If a Review later suggests a block rule, it hands the suggestion to the Owner, who opens it in the Assistant ([ADR 0008](0008-the-assistant-proposes-the-owner-reloads.md)).
- **The whole period is read.** A Review covers the time since the previous one, for every Site with an Access log, streaming the log files, rotated ones included, up to a size limit. Fairway keeps no copy of the logs ([ADR 0004](0004-host-access-logs-from-the-running-config.md)), so what Caddy has rotated away cannot be reviewed; the Review states the period it could not see, as a Gap is shown as unknown.
- **Alerts go through the event log.** Each Observation has a level (info, notable or urgent). A Review with an Observation at or above the level the Owner chose, urgent unless changed, records one Event, which sends one Alert as in [ADR 0006](0006-events-and-alerts-from-one-log.md). The model is given the previous Review's Observations so that daily background scanning is marked as ongoing and not reported as new.
- **Failure is visible.** A failed Review is listed with its reason and tried again after an hour. Two failures in a row record an Event, so a revoked key does not stop Reviews unnoticed. The next Review that succeeds covers the missed period.
- **Schedule.** Off, every 6, 12 or 24 hours, or weekly, with 24 hours as the default, and a button to run one now. It runs inside Fairway's own process, like the Certificate sweep.
- Reviews are kept for 30 days in `DATA_DIR`, except that the newest finished Review is always kept, since the next period starts where it ended. A Review is bounded by a cap on the tokens of each model answer, a limit on calls for log lines and an overall timeout; its usage is recorded and shown, and there is no total token budget. A login is required, as for the Assistant.

## Considered

- **Send the raw lines.** No summarising code to write and the model sees everything, but cost and exposure grow with traffic, and one busy day can exceed what a model reads at once.
- **Raw lines to a local model only.** Keeps everything on the machine, but ties the feature to owning hardware that can run a model good enough to be trusted.
- **Replace client addresses with pseudonyms.** Less leaves the machine, but the Owner then needs Fairway to translate every Observation back, and the model loses what an address range tells it.
- **Let a Review propose or apply a block itself.** The obvious next step, and the reason for the rule: text an attacker wrote must never be one approval away from the proxy's configuration.
