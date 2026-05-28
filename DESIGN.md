# Shofer LLM Router — Design Document

## Overview

Shofer LLM Router is a VS Code extension that consolidates the functionality previously split across two components:

1. **llm-router** (Go microservice) — Provider abstraction, protocol translation, composite model failover, Redis caching
2. **llm-provider** (VS Code extension) — VS Code LM API bridge, side-channel commands, cost ledger

The new extension eliminates the need for a separate running service by embedding all routing logic directly in the VS Code extension host, talking to each provider's API via HTTP.

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
│  └──────────────────────────┬───────────────────────────────┘ │
│                              │                                 │
│  ┌──────────────────────────▼───────────────────────────────┐ │
│  │            LanguageModelProvider                          │ │
│  │  • VS Code LanguageModelChatProvider implementation       │ │
│  │  • Message format conversion (VS Code ↔ OpenAI)          │ │
│  │  • Tool call accumulation + ordering validation           │ │
│  │  • Per-conversation cost ledger                          │ │
│  │  • Side-channel commands (pricing, capabilities, cost)   │ │
│  └──────────┬────────────────────────┬──────────────────────┘ │
│             │                        │                         │
│  ┌──────────▼──────────┐  ┌─────────▼──────────────────────┐ │
│  │   ProviderRouter    │  │      CompositeService          │ │
│  │  • Provider selection│  │  • Failover strategy           │ │
│  │  • API key routing   │  │  • Round-robin strategy        │ │
│  │  • Request prep      │  │  • Health monitoring            │ │
│  │  • Stream transform  │  │  • Throttling                  │ │
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
- Handle chat requests via `provideLanguageModelChatResponse()`
- Convert VS Code messages ↔ OpenAI Chat Completions format
- Accumulate streaming tool calls and report them as `LanguageModelToolCallPart`
- Emit structured `tool_preparing` markers for long tool argument streams
- Validate OpenAI tool-call message sequence constraints
- Maintain per-conversation cost ledger
- Expose side-channel commands (`getPricing`, `getCapabilities`, `getRequestCost`)

### 2. ProviderRouter (`provider-client.ts`)

Routes requests to the correct provider based on model ID.

**Responsibilities:**
- Map model ID → provider type via the model registry
- Select the correct API key for the provider
- Apply provider-specific request transformations before sending
- Route Anthropic requests through the custom Messages API path
- Handle OpenRouter as the catch-all for unknown models

**Provider resolution** (from `getProviderForModel()`):

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
| `shofer/*` | Composite (routed by CompositeService) |
| Anything else | OpenRouter |

### 3. Provider Clients (`providers/*.ts`)

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
- OpenAI-compatible endpoint passthrough
- Forwards `reasoning_effort` and `thinking_config` via extra_body

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

#### OpenRouter (`openrouter.ts`)
- Pure passthrough — catch-all for unknown models

### 4. CompositeService (`composite.ts`)

Handles `shofer/*` composite models with reliability features — the primary place where health monitoring, throttling, and timeout policies live. Any model (even a single one) can be wrapped in a composite config to get these guarantees.

**Strategies:**
- **failover**: Tries models in strict order. On failure (HTTP error, timeout, stream abort), falls back to the next model.
- **round_robin**: Smooth weighted round-robin (nginx-style). Each model has a `weight` (default: 1). The algorithm tracks per-model `currentWeight`, picks the highest, then subtracts the total — distributing proportionally without bursting to high-weight nodes. Unhealthy models are excluded.

**Model configs** accept either a plain string (`"model-id"`) or an object:
```json
{ "id": "model-a", "weight": 5, "throttling": { "maxConcurrent": 10 } }
```
Per-model `throttling` overrides composite-level defaults for that model only.

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

### 5. Model Registry (`model-registry.ts`)

Single source of truth for all model metadata, ported from `llm-router/internal/types/model_registry.go`.

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

### 6. Cost Computation (`llm-client.ts`)

Costs are computed from the registry's per-1K-token pricing × actual token usage:

```
cost = (uncached_prompt_tokens / 1000) × prompt_price
     + (cached_tokens / 1000) × cache_read_price
     + (cache_creation_tokens / 1000) × cache_write_price
     + (completion_tokens / 1000) × completion_price
     × (1 - batch_discount)
```

Pricing is converted from per-1K-token form (registry) to per-1M-token form (Shofer convention) via `toPerMillionPricing()`.

### 7. Secret Storage (`secret-storage.ts`)

API keys are stored using VS Code's `SecretStorage` API under namespaced keys:

```
shofer-router.provider.openai     → sk-...
shofer-router.provider.anthropic  → sk-ant-...
shofer-router.provider.deepseek   → sk-...
...
```

The `onApiKeysChanged` listener detects external changes and triggers reload.

## Data Flow

### Chat Completion Flow

```
1. VS Code calls provideLanguageModelChatResponse()
2. LanguageModelProvider converts VS Code messages → ChatMessage[]
3. Prepend system prompt as System role message
4. Validate OpenAI tool-call sequence constraints
5. Build ChatCompletionRequest
6. Check if model is composite (shofer/*)
   a. YES → CompositeService.sendCompositeRequest()
      - Select candidates via strategy
      - For each candidate: acquire throttle slot, send via ProviderRouter
      - On success: return response; on failure: try next candidate
   b. NO → ProviderRouter.sendStreamingRequest()
7. ProviderRouter resolves provider from model ID
8. Apply provider-specific request transformations
9. Anthropic: custom Messages API path
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
4. For each model: convert registry entry to ProviderModelInfo
5. Fire onDidChangeLanguageModelChatInformation event
6. VS Code picks up models via provideLanguageModelChatInformation()
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

## Differences from llm-router

| Feature | llm-router Approach | shofer-router Approach |
|---------|--------------------|----------------------|
| Provider communication | Go HTTP client with custom transport tuning, connection pooling, HTTP/2 multiplexing, 64KB buffer pools | Node.js `fetch()` API (built into VS Code runtime) |
| Caching | Redis-backed prompt cache + reasoning cache | No caching (direct API calls) |
| Rate limiting | Redis-backed distributed rate limiting | In-process per-instance throttling |
| Health monitoring | Ring buffer, Prometheus metrics, per-replica | Three-state (healthy/degraded/unhealthy) with configurable thresholds and cooldown |
| Multi-tenancy | Designed for multiple concurrent clients | Single user (per VS Code instance) |
| Deployment | Docker container + Redis + Kubernetes | VS Code extension (.vsix) |
| Configuration | Environment variables in `.env` | VS Code settings + SecretStorage |
| Observability | Prometheus metrics + OpenTelemetry tracing | VS Code output channel logging |
| Reasoning cache | Redis-backed DeepSeek/Moonshot reasoning store | Placeholder injection ("•") for missing reasoning_content |

## Security

### API Key Storage
- API keys stored in VS Code's `SecretStorage` (backed by OS keychain on macOS, libsecret on Linux, Credential Vault on Windows)
- Keys are never written to disk in plaintext
- Extension logs never include API key values

### Transport Security
- All provider API calls use HTTPS
- Anthropic uses `x-api-key` header (not Bearer token)
- API keys passed via `Authorization: Bearer` header for OpenAI-compatible providers

## Performance Considerations

### Streaming
- All chat completions use SSE streaming for real-time UX
- Buffer-based SSE parsing with minimal allocations
- Tool call accumulation in memory during streaming

### Connection Reuse
- Node.js `fetch()` handles connection pooling automatically
- No custom transport tuning needed (VS Code runtime manages this)

### Memory
- Cost ledger bounded at 1024 entries (LRU eviction)
- Tool call accumulation maps cleared after each completion
- No persistent caches (no Redis dependency)

## Future Enhancements

- Provider-specific token counting using tiktoken (currently uses 4 chars/token approximation)
- Custom HTTP transport tuning for specific providers
- Provider health dashboard in VS Code
- Automatic model fallback hints in the UI
