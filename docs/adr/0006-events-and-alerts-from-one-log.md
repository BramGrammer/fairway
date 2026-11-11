# One event log feeds both the history and the Alerts

Fairway records every change of a Subject's State, and a few one-shot occurrences such as a failed deploy, in a single append-only log (`events.json` in `DATA_DIR`). The history views read it, and Alerts are sent from it, so the two can never disagree about what happened.

## Why

- "Was it down last night?" and "tell me when it goes down" are the same question asked at two moments. One log means one definition of "down".
- Only transitions are stored, not samples, so the file stays small and survives restarts the same way `metrics.json` does.
- The last known State per Subject lives in the same file, which stops an already-red Certificate from alerting again on every restart or update.

## Consequences

- Alerts are push messages to ntfy, set with `NTFY_URL` (one topic address, or several separated by commas) and an optional `NTFY_TOKEN`, and neither value is ever returned by the API. The environment is the base; [ADR 0007](0007-alert-settings-from-the-interface-over-the-environment.md) adds changing these from Settings.
- A State only changes after it has held long enough (about 15 s for Caddy, 1 minute for an upstream, none for a Certificate). The values are fixed in one place so a settings screen can take them over later.
- Delivery is retried three times (about 10 s, 1 minute, 5 minutes) and then the Event is marked "not delivered". Nothing is queued: a "down" message arriving two days late is worse than none.
- Upstreams have only ok and down. Caddy reports health only for active health checks, and the passive `fails` counter depends on settings the Owner may not use, so it is not turned into a warning. A synthetic check of each host fills the gap for hosts without a health check.
- A Gap, where Fairway was not running, is recorded as unknown and never as down. A Fairway that is down cannot alert about itself.
- Subjects are keyed by name, not by Site, so one upstream shared by two hosts is one Subject and gives one Alert. When a Subject leaves the config its State is closed with a "no longer configured" Event and no Alert.
- Retention is 30 days and 2,000 records, whichever is reached first, so a flapping Subject cannot grow the file without limit.

## Considered

- **Alerts only, no history.** Smaller, but "still down" and "how long" then have no answer, and restarts lose the last notified State.
- **Storing every sample.** Gives sparklines, but duplicates what `metrics.json` already keeps and grows without a clear bound.
- **A queue for undelivered Alerts.** Reliable delivery, but delivers stale news and needs its own state and expiry.
- **A generic JSON webhook, or several channels (Discord, Slack, Telegram).** Each of those expects its own body, so a generic webhook reaches none of them without a bridge. The Owner runs ntfy, which also forwards to other services, so Fairway speaks only ntfy.
