# LLM Local Router — Design Document

## Overview

LLM Local Router is a self-contained VS Code extension that embeds all LLM routing logic directly in the extension host, talking to each provider's API via HTTP — no external services required.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     VS Code Extension Host                     │
│                                                               │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │                    main.ts (Entry Point)                  │ │
│  │  • Extension lifecycle (activate/deactivate)              │ │
│  │  • Configuration management                              │ │
│  │  • Command registration                                  │ │
│  │  • Status bar + health checks                            │ │
│  │  • SecretStorage API key management                      │ │
│  │  • Custom provider loading (settings.json + SecretStorage)│ │
│  └───���──────────────────────┬───────────────────────────────┘ │
│                              │                                 │
│  ┌──────────────────────────▼───────────────────────────────┐ │
│  │            LanguageModelProvider                          │ │
│  │  • VS Code LanguageModelChatProvider implementation       │ │
│  │  • Message format conversion (VS Code ↔ OpenAI)          │ │
│  │  • Tool call accumulation + ordering validation           │ │
│  │  • Per-conversation cost ledger                          │ │
│  │  • Side-channel commands (pricing, capabilities, cost)   │ │
│  │  • Custom provider model → ProviderModelInfo conversion  │ │
│  └──────────┬────────────────────────┬──────────────────────┘ │
│             │                        │                         │
│  ┌──────────▼──────────┐  ┌─────────▼──────────────────────┐ │
│  │   ProviderRouter    │  │      CompositeService          │ │
│  │  • Built-in provider │  │  • Failover strategy           │ │
│  │    selection         │  │  • Round-robin strategy        │ │
│  │  • Custom provider   │  │  • Lowest-latency strategy     │ │
│  │    resolution        │  │  • Health monitoring           │ │
│  │  • Protocol-based    │  │  • Throttling                  │ │
│  │    handler factory   │  │  • TTFB latency tracking       │ │
│  │  • API key routing   │  │  • Highest-reliability strategy│ │
│  │  • Request prep      │  │                                │ │
│  │  • Stream transform  │  │                                │ │
│  └──────────┬───────────┘  └────────────────────────────────┘ │
│             │                                                  │
│  ┌──────────▼──────────────────────────────────────────────┐ │
│  │                  Provider Clients                        │ │
│  │  ┌────────┐ ┌──────────┐ ┌────────┐ ┌──────────┐       │ │
│  │  │ OpenAI │ │Anthropic │ │ Google │ │ DeepSeek │ ...   │ │
│  │  └────────┘ └──────────┘ └────────┘ └──────────┘       │ │
│  │  Each provider handles:                                  │ │
│  │  • Protocol-specific request transformation              │ │
│  │  • Response parsing (JSON + SSE streaming)               │ │
│  │  • Reasoning/thinking content handling                   │ │
│  └─────────────────────────────────────────────────────────┘ │
│             │                                                  │
└─────────────┼──────────────────────────────────────────────────┘
              │
    ┌─────────┴──────────┐
    ▼                    ▼
┌────────┐         ┌──────────┐
│OpenAI  │         │Anthropic │  ...
└────────┘         └──────────┘
```

## Component Design

### 1. LanguageModelProvider (`language-model-provider.ts`)

Implements `vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation>`. This is the primary integration point with VS Code's LM API.

**Responsibilities:**
- Register models from the built-in registry via `provideLanguageModelChatInformation()`
- Register custom (user-defined) provider models alongside built-in models
- Handle chat requests via `provideLanguageModelChatResponse()`
- Convert VS Code messages ↔ OpenAI Chat Completions format
- Accumulate streaming tool calls and report them as `LanguageModelToolCallPart`
- Emit structured `tool_preparing` markers for long tool argument streams
- Validate OpenAI tool-call message sequence constraints
- Maintain per-conversation cost ledger
- Expose side-channel commands (`getPricing`, `getCapabilities`, `getRequestCost`).
  `getCapabilities` also carries per-model native-tool preferences
  (`includedTools`/`excludedTools`) since the VS Code LM API's `capabilities`
  cannot — see "Per-model tool preferences" in the README.

### 2. ProviderRouter (`provider-client.ts`)

Routes requests to the correct provider based on model ID. Supports both built-in providers (via `ProviderType` enum) and user-registered custom providers.

**Responsibilities:**
- Map model ID → provider type via the model registry (built-in)
- Resolve custom provider models via a reverse index (`customModelIndex`)
- Build per-protocol handlers for custom providers (`buildCustomHandler`)
- Select the correct API key for both built-in and custom providers
- Apply provider-specific request transformations before sending
- Route Anthropic requests through the custom Messages API path
- Route Google requests through the native Gemini API path
- Handle OpenRouter as the catch-all for unknown models

**Provider resolution** (from `resolveProvider()`):

| Model pattern | Provider |
|---------------|----------|
| `gpt-*` | OpenAI |
| `claude-*` | Anthropic |
| `gemini-*` | Google |
| `deepseek-*` | DeepSeek |
| `MiniMax-*` | MiniMax |
| `kimi-*` | Moonshot |
| `mimo-*` | Xiaomi |
| `glm-*` | Zhipu |
| `local/*` | Composite (routed by CompositeService) |
| Custom provider model | Resolved via customModelIndex |
| Anything else | OpenRouter |

### 3. Custom Primary Providers

Users can register their own LLM providers through the webview UI or `settings.json`. Each custom provider specifies:

- **Provider ID** — unique, lowercase identifier (must not collide with built-in names)
- **Label** — human-readable display name
- **Protocol** — one of `openai-compatible`, `anthropic-compatible`, or `google-compatible`
- **Endpoint URL** — base URL for the provider's API
- **API Key** — stored in SecretStorage under `llm-local-router.provider.custom.{id}`
- **Models** — array of model definitions (id, name, contextLength, maxOutputTokens, imageInput, toolCalling, thinking)
- **Default Pricing** — per 1M tokens (prompt, completion, cache read)

**Source of Truth:**
| What | Storage |
|------|---------|
| Custom provider metadata | `settings.json` (`llmLocalRouter.customProviders`) |
| Custom provider API keys | `SecretStorage` (`llm-local-router.provider.custom.{id}`) |
| Built-in provider API keys | `SecretStorage` (`llm-local-router.provider.{name}`) |
| Composite models | `settings.json` (`llmLocalRouter.compositeModelsConfig`) |

**Protocol handling** — `buildCustomHandler()` creates the appropriate `ProviderHandler`:
- `openai-compatible` → pure passthrough (standard `/v1/chat/completions`)
- `anthropic-compatible` → Anthropic Messages API translation with streaming SSE parsing
- `google-compatible` → Google Gemini native API with visible thinking

### 4. Provider Clients (`providers/*.ts`)

Each provider file handles protocol-specific transformations:

#### OpenAI (`openai.ts`)
- **GPT-5.x / o-series**: Remaps `max_tokens` → `max_completion_tokens` (OpenAI's convention for reasoning models)
- Forwards `reasoning_effort` parameter

#### Anthropic (`anthropic.ts`)
- **Full Messages API translation**: The most complex provider adapter
- **Request**: System messages → top-level `system` field; content → string or content blocks; tools → Anthropic tool format
- **Response**: Content blocks → message content + tool_calls; stop_reason → finish_reason mapping
- **Streaming**: Parses SSE events (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`) → OpenAI-compatible chunks
- Tool use blocks emit opening deltas on `content_block_start`
- Uses `x-api-key` header + `anthropic-version: 2023-06-01`

#### Google Gemini (`google.ts`)
- **Native Gemini API** (custom-send path, not OpenAI-compatible): translates to/from `generateContent`/streaming, surfaces thinking as `reasoningContent`, accumulates tool calls (with synthesized unique IDs) into the final response, and computes `costUsd` with cached tokens on the canonical field
- Vertex reuses this native path via a no-op preparer (`vertex.ts`)

#### DeepSeek (`deepseek.ts`)
- **Reasoning content round-trip**: Injects `•` placeholder for missing `reasoning_content` on assistant messages (DeepSeek requires non-empty reasoning_content on every assistant message in thinking mode)
- Maps `prompt_cache_hit_tokens` → canonical `cached_tokens`
- Forwards `reasoning_effort` for thinking control

#### MiniMax (`minimax.ts`)
- **`<think>` tag extraction**: Extracts `<think>...</think>` blocks from content into `reasoning_content`
- Enables `reasoning_split=true` for proper thinking separation
- Handles both streaming and non-streaming responses

#### Moonshot / Kimi (`moonshot.ts`)
- **Reasoning content requirement**: Like DeepSeek, Kimi requires `reasoning_content` on assistant messages for multi-turn tool calls
- Injects `•` placeholder for missing reasoning content

#### Xiaomi MiMo (`xiaomi.ts`)
- **`max_completion_tokens` remapping**: MiMo uses `max_completion_tokens` instead of `max_tokens`
- **Thinking parameter**: Injects `extra_body.thinking` based on model (enabled for pro/omni, disabled for flash/tts)
- **`reasoning_details` → `reasoning_content`**: Converts RooCode's reasoning_details format for multi-turn tool calls
- Removes `stream_options` (not supported)

#### Zhipu GLM (`zhipu.ts`)
- **Thinking toggle**: Enables `extra_body.thinking` for GLM 4.x/5.x models

#### Plain OpenAI-compatible providers (OpenRouter, Mistral, xAI, Ollama, LM Studio, Fireworks, SambaNova, Baseten, Requesty, Unbound, Vercel AI Gateway)
- No request transformation needed — they share a single `noopPreparer` in `provider-client.ts` (base URLs live in `PROVIDER_BASE_URLS`). OpenRouter is the catch-all for unknown models.

### 5. CompositeService (`composite.ts`)

Handles `local/*` composite models with reliability features — the primary place where health monitoring, throttling, and timeout policies live. Any model (even a single one) can be wrapped in a composite config to get these guarantees.

**Strategies:**

All four strategies return an **ordered candidate list** (preferred model first, then the
remaining healthy models), so a pre-first-byte failure of the chosen model still fails over
to the next — failover is not exclusive to the `failover` strategy.

- **failover**: Tries models in strict order. On failure (HTTP error, timeout, stream abort), falls back to the next model.
- **round_robin**: Smooth weighted round-robin (nginx-style). Each model has a `weight` (default: 1). The algorithm tracks per-model `currentWeight`, picks the highest, then subtracts the total — distributing proportionally without bursting to high-weight nodes. Unhealthy models are excluded; the remaining healthy models follow the SWRR pick as failover candidates.
- **lowest_latency**: Picks the model with the lowest average TTFB over a configurable sliding window (default: 10 minutes), with the rest sorted by ascending latency behind it. The estimate is the **mean of in-window samples**, pruned at read time, so an idle model's stale latency never wins. When no in-window latency data exists (cold start), falls back to equal-weight round-robin.
- **highest_reliability**: Always picks the model with the highest success ratio (successes ÷ attempts) over the same configurable sliding window (`latencyWindowMs`, default: 10 minutes). Remaining healthy models follow in descending reliability so failover still has candidates. Untested models are given the benefit of the doubt (treated as 1.0) so they get sampled rather than ranked below a known-unreliable model. When no reliability data exists at all (cold start), falls back to equal-weight round-robin.

**Model configs** accept either a plain string (`"model-id"`) or an object:
```json
{ "id": "model-a", "weight": 5, "throttling": { "maxConcurrent": 10 } }
```
Per-model `throttling` overrides composite-level defaults for that model only.

**Latency tracking (lowest_latency strategy):**
- TTFB is measured per-model on each successful composite request
- The estimate is the **mean of samples within `latencyWindowMs`** (default: 600s), computed and pruned at read time — so a model that has gone idle past the window reports no estimate (and is not preferred) rather than a stale value
- Mid-stream failures (after first byte) are recorded as health failures so a consistently mid-stream-failing model is still marked degraded/unhealthy

**Reliability tracking (highest_reliability strategy):**
- Each composite attempt records a success/failure outcome per-model (success = reached first byte)
- The success ratio is computed over the same `latencyWindowMs` sliding window, applied at read time
- Retained samples are capped per model (500) to bound memory; the window filter is the real selector

**Health tracking — three states:**
| State | Trigger | Behavior |
|-------|---------|----------|
| `healthy` | Initial / after success | Normal routing |
| `degraded` | `degradedThreshold` consecutive failures (default: 1) | Still used, but failure counter accumulates |
| `unhealthy` | `failureThreshold` consecutive failures (default: 3) | Quarantined — skipped during candidate selection |

Unhealthy models are probed after `cooldownMs` (configurable, default: 30s) by transitioning back to `degraded` for a single probe attempt.

**Throttling (per-model):**
- **Concurrency limit** (`maxConcurrent`): Maximum in-flight requests per model (default: 50)
- **Sliding window rate limit** (`requestsPerWindow` / `windowMinutes`): Maximum requests per time window (default: 100 per 5 minutes)
- Throttled models are skipped during candidate selection
- Each underlying model can have independent throttling via `{id, throttling}` config

**Timeouts — three levels:**
- `streamingTimeoutMs` (default: 30s) — inactivity timeout for streaming; resets on each received chunk so a steadily-streaming thinking model is never cancelled mid-response
- `perAttemptTimeoutMs` (default: 120s) — hard wall-clock deadline for non-streaming attempts
- `totalTimeoutMs` (default: 300s) — total budget across all failovers; once exceeded, the best error so far is returned

**First-byte rule:** Streaming failover is only possible before the first response chunk is sent. Once data flows to the client, the current model must complete — mid-stream failures propagate to the client.

**Capability intersection:** Composite model entries surfaced via the VS Code LM API are computed by intersecting the capabilities of all underlying models — the minimum `maxInputTokens`/`maxOutputTokens` and the boolean AND of `imageInput`/`toolCalling`/`promptCache`. This is the safe lower bound: any request fitting the advertised capabilities is guaranteed to fit every underlying candidate, so failover never gets blocked on capability mismatch.

### 6. Model Registry (`model-registry.ts`)

Single source of truth for all built-in model metadata.

Each entry includes:
- Model ID, name, description
- Context length and max output tokens
- Provider type
- Pricing (USD per 1K tokens)
- Capabilities (image input, tool calling)

The registry is used for:
- Model discovery via VS Code LM API
- Provider resolution
- Cost computation (pricing × usage)
- Capability flags (prompt cache support derived from cache-read pricing)

### 7. Cost Computation (`llm-client.ts`)

Costs are computed from the registry's per-1K-token pricing × actual token usage:

```
cost = (uncached_prompt_tokens / 1000) × prompt_price
     + (cached_tokens / 1000) × cache_read_price
     + (cache_creation_tokens / 1000) × cache_write_price
     + (completion_tokens / 1000) × completion_price
     × (1 - batch_discount)
```

Pricing is converted from per-1K-token form (registry) to per-1M-token form (the form the VS Code LM API expects) via `toPerMillionPricing()`.

`computeCost()` is applied uniformly across all providers — including the custom-send
adapters (Anthropic, Google/Gemini), which build their `UsageInfo` by hand and call
`computeCost()` so `costUsd` is populated consistently (otherwise the cost ledger and
metrics would record $0 for those providers). All providers normalize cached tokens onto
the canonical `cachedTokens`/`cacheCreationTokens` fields that `computeCost` reads.

### 8. Secret Storage (`secret-storage.ts`)

API keys are stored using VS Code's `SecretStorage` API under namespaced keys:

```
llm-local-router.provider.openai        → sk-...
llm-local-router.provider.anthropic     → sk-ant-...
llm-local-router.provider.deepseek      → sk-...
llm-local-router.provider.custom.{id}   → custom provider API key
```

The `onApiKeysChanged` listener detects external changes and triggers reload. Custom provider API keys are loaded by scanning `settings.json` for registered custom provider IDs and looking up each key in SecretStorage.

## Data Flow

### Chat Completion Flow

```
1. VS Code calls provideLanguageModelChatResponse()
2. LanguageModelProvider converts VS Code messages → ChatMessage[]
3. Prepend system prompt as System role message
4. Validate OpenAI tool-call sequence constraints
5. Build ChatCompletionRequest
6. Check if model is composite (local/*)
   a. YES → CompositeService.sendCompositeRequest()
      - Select candidates via strategy (failover / round_robin / lowest_latency)
      - For each candidate: acquire throttle slot, send via ProviderRouter
      - Track TTFB per model for lowest_latency strategy
      - On success: return response; on failure: try next candidate
   b. NO → ProviderRouter.sendStreamingRequest()
7. ProviderRouter resolves provider from model ID
   - Check customModelIndex first, then built-in registry
   - For custom providers: build protocol handler from provider config
8. Apply provider-specific request transformations
9. Anthropic / anthropic-compatible: custom Messages API path
   Google / google-compatible: native Gemini API path
   Others: standard OpenAI-compatible HTTP POST to provider's /v1/chat/completions
10. Parse SSE stream (data: {...}\n\n)
11. Apply chunk transformers (MiniMax reasoning_details → reasoning_content, DeepSeek prompt_cache_hit_tokens mapping)
12. For each chunk:
     - Report reasoning_content as LanguageModelThinkingPart
     - Report text content as LanguageModelTextPart
     - Accumulate tool call deltas
     - Emit tool_preparing markers
13. On stream completion:
     - Report accumulated tool calls as LanguageModelToolCallPart
     - Compute and record cost in ledger
```

### Model Discovery Flow

```
1. LanguageModelProvider.fetchModels()
2. getProviderModelInfoList() reads from ALL_MODELS registry
3. For each composite model: compute capability intersection from underlying models
4. For each custom provider: convert CustomProviderModel → ProviderModelInfo
5. For each model: convert registry entry to ProviderModelInfo
6. Fire onDidChangeLanguageModelChatInformation event
7. VS Code picks up models via provideLanguageModelChatInformation()
```

## Error Handling

### Provider Errors
- HTTP errors (4xx/5xx) → `LLMClientError` with status code and body
- Network errors → `LLMClientError` with connection details
- SSE parse errors → Logged, skipped (individual chunk failures don't abort the stream)
- Timeout → AbortController fires, request cancelled

### Composite Model Failover
- Upstream failure → Next candidate tried
- Throttled model → Skipped in candidate selection
- Unhealthy model → Skipped (probed after cooldown)
- All models exhausted → Error thrown with attempt details

### Tool Call Validation
- Diagnostic logging for invalid OpenAI tool-call sequences
- Duplicate tool_call_ids → Warning logged
- Orphaned tool messages → Dropped with warning
- Out-of-order tool messages → Reordered automatically

### 9. Metrics Collector (`metrics-collector.ts`)

In-process, in-memory metrics aggregation with 5-minute aligned time windows, suitable for a VS Code extension.

**Design rationale**: metrics are aggregated in-memory and exposed via:
- Webview dashboard with all 10 metric charts on a single scrollable page
- Side-channel commands (`llmLocalRouter.getMetrics`, `llmLocalRouter.exportMetrics`, etc.)
- SQLite persistence
- An **optional** Prometheus scrape endpoint (`metrics-server.ts`) on `127.0.0.1`, gated behind the `llmLocalRouter.experimental.prometheusEndpoint` setting (default off; loopback-only, no auth). Port via `LLM_LOCAL_ROUTER_METRICS_PORT` (default 30098).

**Window structure**: Each 5-minute window aggregates per-model statistics:
- Request counts by status (success/error/timeout/cancelled)
- Latency: TTFB and TTLB samples with p50/p90/p99 percentiles
- Token aggregates: prompt, completion, cached, cache creation
- Cost (USD) from registry pricing × actual usage
- Cache hit ratio: cached / total prompt tokens
- Error type breakdown (http_4xx, http_5xx, http_429, timeout, cancelled, network_error, parse_error, unknown)
- Availability: success / (success + error + timeout)

**Composite model tracking**: Each window also records composite routing distributions — which underlying model served how many requests, failover counts, mid-stream failures, and total attempts.

**Throttle tracking**: Models skipped during composite candidate selection due to rate/concurrency limits are counted separately.

**Memory**: Up to 288 windows retained (24 hours at 5-minute granularity). Each window stores per-model stats including raw latency samples. For a single-user extension, this is well under 1 MB.

**Prometheus export**: `toPrometheusText()` produces Prometheus text format compatible with node_exporter textfile collector, enabling external scraping if desired.

**SQLite persistence** (`metrics-storage.ts`): Automatic persistence via sql.js (SQLite compiled to WebAssembly — pure TypeScript, no native addons). On each 5-minute window boundary, the closing window's aggregated stats and raw request entries are flushed to disk. On startup, recent windows (last 24h) are loaded back into memory. The database file lives in VS Code's `globalStorageUri`. Retention is 30 days with automatic pruning every 100 windows (~8.3 hours).

### 10. Metrics Storage (`metrics-storage.ts`)

SQLite persistence layer using `sql.js` (SQLite compiled to WebAssembly) for storing per-request entries and pre-aggregated window data.

**Schema**: Two tables —
- `requests`: Raw per-request entries (18 columns) with indexes on timestamp, model_id, status, and composite_model_id
- `windows`: Pre-aggregated ModelWindowStats as JSON blobs, keyed by (window_start, model_id)

**Write path**: `MetricsCollector.ensureCurrentWindow()` detects window transitions and calls `flushCurrentWindow()`, which batch-inserts raw entries and upserts window JSON blobs in a single transaction.

**Read path**: `loadWindows(since)` reconstructs MetricsWindow objects from the per-model JSON blobs. `queryRequests(modelId, since)` returns raw request entries for detailed historical analysis. `getCostBreakdown(since)` returns per-model cost aggregates.

**Maintenance**: Automatic pruning deletes data older than 30 days. The database file is stored in `vscode.ExtensionContext.globalStorageUri`.

**Persistence cost**: sql.js is an in-memory database; durability comes from exporting the whole DB and rewriting the file (the `journal_mode`/`synchronous` pragmas are inert under sql.js's in-memory VFS). Because that export+write is O(total DB size), it is **debounced** (~1.5s) so bursts of writes coalesce into one flush off the hot path; `close()` flushes synchronously so clean shutdowns stay durable (a crash can lose at most the debounce window of un-flushed data).


## Security

### API Key Storage
- API keys stored in VS Code's `SecretStorage` (backed by OS keychain on macOS, libsecret on Linux, Credential Vault on Windows)
- Custom provider API keys stored under `llm-local-router.provider.custom.{id}`
- Custom provider metadata (non-sensitive) stored in `settings.json`
- Keys are never written to disk in plaintext
- Extension logs never include API key values

### Transport Security
- All provider API calls use HTTPS
- Anthropic uses `x-api-key` header (not Bearer token)
- API keys passed via `Authorization: Bearer` header for OpenAI-compatible providers

## Performance Considerations

### Streaming
- All chat completions use SSE streaming for real-time UX
- A single shared SSE reader (`readSSE()` in `llm-client.ts`) backs all provider stream parsers (OpenAI-compatible, Anthropic, Gemini) — buffer-based line splitting with chunk-boundary handling, CRLF tolerance, lenient `data:` matching, comment/`event:`-line skipping, and a final-line flush at EOF
- Tool call accumulation in memory during streaming

### Connection Reuse
- Node.js `fetch()` handles connection pooling automatically
- No custom transport tuning needed (VS Code runtime manages this)

### Memory
- Cost ledger bounded at 1024 entries (LRU eviction)
- Tool call accumulation maps cleared after each completion
- Latency trackers per model (small in-window samples array, pruned at read time)
- No persistent caches (no Redis dependency)

## Metrics & Observability

### Dashboard

The webview Metrics tab shows all 10 metric charts stacked on a single scrollable page:
- Cost, Cost (Cumulative), Requests, Errors
- Tokens (Total/Prompt/Completion)
- Latency (TTFB/TTLB)
- Cache Hit Ratio

A sticky Table of Contents bar at the top provides anchor-link navigation to jump directly to any chart. The model picker is categorized into **Primary** and **Composite** groups with separate ALL toggles, preventing double-counting between composite models and their underlying primaries.

### Collected Metrics

Every chat completion request (success or failure) is recorded automatically. The following metrics are tracked per 5-minute window:

#### (a) Cost & Token Usage by Model
| Metric | Description |
|--------|-------------|
| `totalCostUsd` | USD cost from registry pricing × actual token usage |
| `totalPromptTokens` | Total input/prompt tokens |
| `totalCompletionTokens` | Total output/completion tokens |
| `totalCachedTokens` | Tokens served from prompt cache (lower cost) |
| `totalCacheCreationTokens` | Tokens written to prompt cache |
| `cacheHitRatio` | cached / total prompt tokens |

#### (b) Reliability (Latency, Availability, SLO)
| Metric | Description |
|--------|-------------|
| `ttfbP50/P90/P99` | Time-to-first-byte percentiles (ms) |
| `ttlbP50/P90/P99` | Time-to-last-byte percentiles (ms) |
| `availability` | success / (success + error + timeout) ratio |
| `errorTypes` | Breakdown by error class (http_4xx, http_5xx, http_429, timeout, network_error, etc.) |
| `successCount / errorCount / timeoutCount / cancelledCount` | Request outcome counters |

#### (c) Primary & Composite Models
Both primary models (e.g., `deepseek-v4-pro`) and composite models (e.g., `local/code`) are tracked identically. The `isComposite` flag distinguishes them.

#### (d) Composite Load-Balancing Distribution
| Metric | Description |
|--------|-------------|
| `CompositeDistribution.modelCounts` | underlyingModelId → request count |
| `CompositeDistribution.failoverCount` | Requests where at least one failover occurred |
| `CompositeDistribution.midstreamFailureCount` | Failures after first byte (unrecoverable) |
| `CompositeDistribution.totalAttempts` | Total attempts across all requests |

#### (e) Additional KPIs
| Metric | Description |
|--------|-------------|
| `throttleSkipCount` | Models skipped during candidate selection due to rate/concurrency limits |
| `perWindow requestCount` | Request volume per 5-minute window |
| `prompt/completion token ratio` | Efficiency metric (derivable from aggregates) |
| Error budget | If SLO target is 99%, error budget = 1% × total requests (derivable) |

### Commands

| Command | Description |
|---------|-------------|
| `LLM Local Router: Configure` | Open the full configuration dashboard |
| `LLM Local Router: Show Models` | View status and available models |
| `LLM Local Router: Show Metrics` | Open the metrics dashboard |
| `LLM Local Router: Show Model Stats` | Detailed stats for a specific model |
| `LLM Local Router: Export Metrics (Prometheus)` | Prometheus text format export |
| `LLM Local Router: Show Composite Distribution` | Load-balancing distribution for composite models |
| `LLM Local Router: Show Cost History` | Cost breakdown by model across a selected time range |

### Export Format

The Prometheus export produces gauges for the current window:
```
llm_local_router_requests_window{model, provider, status}
llm_local_router_cost_usd_window{model, provider}
llm_local_router_tokens_window{model, provider, type}
llm_local_router_latency_seconds{model, provider, quantile, phase}
llm_local_router_availability{model, provider}
llm_local_router_cache_hit_ratio{model, provider}
llm_local_router_composite_requests{composite, underlying}
llm_local_router_composite_failover_total{composite}
llm_local_router_throttle_skips_total{model}
llm_local_router_errors_window{model, error_type}
```

## Future Enhancements

- Provider-specific token counting using tiktoken (currently uses 4 chars/token approximation)
- Custom HTTP transport tuning for specific providers
- Provider health dashboard in VS Code
- Automatic model fallback hints in the UI
