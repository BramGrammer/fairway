# The Assistant proposes, the Owner reloads

The Assistant is an AI chat beside the editor. It can answer questions about the Caddyfile and offer a Proposal: a changed Caddyfile shown as a difference against what is in the editor. Accepting a Proposal only changes the editor. Validation and Reload stay the Owner's own step, through the same Deploy as any hand-written edit. The Assistant has no way to reload, not even after the Owner approves in the chat.

## Why

- "Fairway never holds an invalid Caddyfile as the live one" and "the Owner must confirm a Reload that has warnings" already describe one guarded path to the live proxy. A second path for the AI would need the same guards again and would be the one that gets them wrong.
- A model's change to a reverse proxy can be valid and still wrong: the right syntax on the wrong Site. Caddy cannot catch that; a person reading a difference can.
- The Caddyfile is only ever edited as text, so a Proposal is text too and the existing difference view and editor show it with nothing new to learn.

## Consequences

- **The model checks its own draft.** Before a Proposal is shown, it is run through Validation, and the model gets the Findings back to correct itself, three attempts at most. After that the Proposal is shown anyway, marked as not valid and with its Findings, since a near miss is more useful than nothing. Validation does not touch the file or the running Caddy.
- **The Assistant works from the editor, not from the live Caddyfile.** Every turn sends what is in the editor at that moment, unsaved edits included. The Owner's own edits are never overwritten, and a Conversation continued days later is not working from a stale Caddyfile.
- **One Proposal is pending at a time.** A follow-up message revises it. If the editor changes underneath, the Proposal is marked outdated and cannot be accepted. Proposals in an older Conversation are history only.
- **It sees the Caddyfile and its Findings, nothing else.** No Events, no Access logs, no Certificates. Diagnosing a failing Site is a different feature with a different answer to what may be sent out.
- **Secrets are masked on the way out.** The Caddyfile goes to an outside provider, so values Fairway recognises as secrets (provider tokens, password hashes, keys in headers) are replaced by stable placeholders before sending and put back in the Proposal. Masking only knows the directives it was taught, so a Finding also flags secrets written inline and points at `{env.X}`. Stored Conversations hold the masked text.
- **Conversations are kept for 30 days** in `DATA_DIR`, like the Event history.
- **A login is required.** Without one, anyone who can reach the page could spend the Owner's credit and read Conversations, so the Assistant is off, as in [ADR 0007](0007-alert-settings-from-the-interface-over-the-environment.md) for where Alerts go.
- Each turn has a hard limit on tool calls and tokens, and its usage is recorded.

## Considered

- **Reload after approval in the chat.** One click fewer, but approval in a chat is given to a sentence, not to a difference, and warnings would need a second confirmation flow inside the chat.
- **Apply Proposals to the editor at once, with undo.** Faster, but a change the Owner did not look at then sits among their own edits.
- **Structured operations ("add a Site", "set an upstream") instead of text.** Safer to apply, but Fairway has no model it writes back from; the structured view is derived from Caddy's adapted configuration and is read-only. Building a writer would be a larger project than the Assistant.
- **Work from the live Caddyfile.** Simpler to reason about, but a Proposal would then discard unsaved edits or conflict with them.
