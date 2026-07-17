# LLM Local Router — Roadmap

Where this is going, and what is deliberately out of scope. Dated items are intent, not
promises. The engineering backlog with issue-level detail lives in [`TODO.md`](TODO.md);
this file is the product-level view.

## The thesis

One provider, every model, **inside the editor**. The router is a VS Code Language Model
provider — not a chat UI, not a proxy, not a service. Everything on this roadmap has to
survive three constraints:

1. **No middleman.** Requests go editor → provider. If a feature needs a hosted service to
   work, it does not belong here.
2. **Keys stay local.** Provider keys live in VS Code SecretStorage and are never emitted by
   an export.
3. **Provider-agnostic.** Nothing may assume a particular consumer (Copilot Chat, an agent
   extension, your own code) or a particular provider.

## Now — shipped

- **9 built-in providers** + user-registered custom providers (OpenAI-, Anthropic- and
  Google-compatible protocols).
- **Composite models** (`local/*`): failover, weighted round-robin, lowest-latency,
  highest-reliability, with in-process health tracking and throttling.
- **Metrics dashboard**: cost, requests, errors, tokens, TTFB/TTLB, cache-hit ratio, per
  model, 1h→30d, plus a Prometheus scrape endpoint (experimental, loopback-only).
- **Cost ledger** per conversation, with per-model pricing overrides.
- **Whole-config import/export** from the Config panel.

## Next — correctness and polish

Small, user-visible, no architecture involved.

- **Fix float artifacts in displayed pricing.** Per-1M conversion surfaces raw binary
  fractions (`$0.13999999999999999`). Round at the formatting layer.
- **Real token counting.** `provideTokenCount` is a `length / 4` heuristic that ignores
  image, thinking and tool-result parts — wire a tokenizer, or label it an estimate in the
  UI (`#P17`).
- **Per-model throttling survives the webview round-trip.** Currently dropped, because the
  webview model has no field for it (`#C7`).
- **Harden Anthropic streaming token accounting** — read all `usage` fields on
  `message_delta` (`#P5`).

## Then — depth

- **Model catalog discovery.** The built-in registry is hand-maintained and dates. Pull
  model metadata (context window, capabilities, pricing) from a live source, with a pinned
  fallback so a network failure never empties the picker.
- **Composite ergonomics.** Composites are powerful and fiddly: the strategy/health/timeout
  surface deserves presets ("cheapest that works", "fastest first") over raw knobs.
- **Metrics durability.** Up to one 5-minute window of raw metrics is lost on a
  non-graceful shutdown (`#M1`); read-time aggregation materializes every sample per model
  (`#M7`).
- **Webview decomposition.** `ProvidersPanel` (~894 lines) and `MetricsPanel` (~558 lines)
  want splitting, with the broken memos in the latter fixed (`#W10`, `#W11`, `#W3`).

## Later — direction

- **Routing on observed behaviour, not just declared strategy.** The router already measures
  TTFB and success ratio per model. Budget-aware routing ("stay under $X/day, degrade to the
  cheap model") is the natural next step, and is only credible because the metrics are real.
- **Local models as first-class citizens.** Ollama and LM Studio are already in the provider
  list; a local model as a *failover target* for a cloud model is an obvious composite.

## Not doing

- **Becoming a chat UI.** There are good ones. This adds models to them.
- **A hosted router / gateway.** The entire point is that there isn't one.
- **Exporting API keys by default.** Export reports which providers are keyed, never the
  values, so an exported config stays shareable. An opt-in may appear; the default will not
  change.
- **Telemetry.** The metrics are yours, they stay on your machine, and nothing is phoned
  home.
