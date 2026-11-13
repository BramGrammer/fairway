# One OpenAI-compatible endpoint, called directly

The Assistant and Reviews reach a model through one endpoint that speaks the OpenAI chat-completions format. The address defaults to OpenRouter and can be changed, which also covers OpenAI itself and local servers such as Ollama. Fairway calls it with `fetch`; there is no provider library and no layer of per-provider adapters.

## Why

- OpenRouter was the wish, and its format is the one most providers and local servers also accept. Making the address a setting gives the others for free.
- The Owner chooses the model per task, because editing a Caddyfile and reading a digest ask for different strengths and prices. A router with many models behind one key fits that better than one vendor's library.
- The server has two runtime dependencies. A request with messages and tools, and a streamed answer, is small enough to own.

## Consequences

- **Tool calling is required.** The Assistant validates its drafts through a tool and a Review reads lines through one. Not every model behind a compatible endpoint supports tools, so Settings has a test that checks the chosen model before it is used.
- **Only the common part of the format is used.** Features that one provider adds on top (its own caching controls, its own reasoning options) are not relied on, so some models will cost more or do worse than they could through their vendor's own interface.
- **Settings follow [ADR 0007](0007-alert-settings-from-the-interface-over-the-environment.md).** The environment gives the address, the key and the models; what the Owner changes in Settings is kept in `DATA_DIR` (mode 0600) and wins until reset. The key is write-only: the API never returns it. A login is required to set it.
- **Two tasks, two models.** One for the Assistant and one for Reviews. Until an address, a key and a model are set, the feature is hidden.
- Pointing the address at a server on the same machine keeps the Caddyfile and the digest from leaving it, for an Owner who wants that and has the hardware.

## Considered

- **One vendor's library.** The best use of that vendor's models, but one vendor only, and a second dependency for what is one request.
- **An adapter per provider.** Each provider at its best, but several code paths to test before either feature has shown its worth. It can be added behind the same module if the common format proves too thin.
