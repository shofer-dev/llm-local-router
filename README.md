# Shofer Router

A VS Code extension that provides **direct access to multiple LLM providers** with **composite model failover** — self-contained, no external router service required.

## Features

- **9 built-in LLM providers + custom providers**: OpenAI, Anthropic, Google Gemini, DeepSeek, MiniMax, Moonshot/Kimi, Xiaomi MiMo, Zhipu GLM, OpenRouter — plus **user-registered custom providers** via the webview UI
- **Composite models** (`shofer/*`): **Failover**, **weighted round-robin**, **lowest-latency**, and **highest-reliability** strategies across multiple underlying models with in-process health monitoring and throttling
- **Full protocol translation**: Anthropic Messages API ↔ OpenAI Chat Completions, MiniMax `<think>` tag handling, DeepSeek/Moonshot reasoning_content round-trip, Xiaomi max_completion_tokens remapping, Zhipu thinking toggle
- **Streaming**: SSE streaming for all providers with real-time tool call accumulation
- **Cost tracking**: Per-token pricing from the built-in model registry, per-conversation cost ledger
- **VS Code LM API**: Implements `LanguageModelChatProvider` for Copilot and Shofer integration
- **Metrics dashboard**: All 10 metric charts on a single page with ToC navigation, categorized Primary/Composite model picker
- **Side-channel commands**: `shofer.llm.getModelPricing`, `shofer.llm.getModelCapabilities`, `shofer.llm.getRequestCost`
- **Secure API keys**: Stored via VS Code's `SecretStorage` API

## Requirements

- VS Code 1.100.0 or later
- API keys for at least one supported provider

## Supported Providers

| Provider | Models | API Key |
|----------|--------|---------|
| OpenAI | gpt-5.5, gpt-5.5-pro, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano | `openai` |
| Anthropic | claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5 | `anthropic` |
| Google | gemini-3.1-pro-preview, gemini-3-flash-preview, gemini-3.1-flash-lite-preview | `google` |
| DeepSeek | deepseek-v4-pro, deepseek-v4-flash | `deepseek` |
| MiniMax | MiniMax-M2.7, MiniMax-M2.5 | `minimax` |
| Moonshot | kimi-k2-thinking, kimi-k2.5 | `moonshot` |
| Xiaomi | mimo-v2-pro, mimo-v2-omni, mimo-v2-tts, mimo-v2-flash | `xiaomi` |
| Zhipu | glm-5.2, glm-5.1, glm-5, glm-4.7, glm-4.6, glm-4.5 | `zhipu` |
| OpenRouter | auto (passthrough for unknown models) | `openrouter` |
| **Custom** | Any provider via the webview UI | User-defined |

## Configuration

### Provider API Keys

API keys are stored securely using VS Code's `SecretStorage`. Use the VS Code command palette to set them:

1. Open Command Palette (`Ctrl+Shift+P`)
2. Run `Shofer Router: Configure`
3. Go to **Config → Primary Providers** and enter your API keys

The extension reads keys from SecretStorage under the keys `shofer-router.provider.{name}` (e.g., `shofer-router.provider.openai`).

### Custom Primary Providers

Register your own LLM providers via the **Config → Primary Providers** tab → **+ New** button. Each custom provider needs:

- A unique **Provider ID** and display **Label**
- An **API Protocol**: OpenAI Compatible, Anthropic Compatible, or Google Compatible
- An **Endpoint URL** and **API Key**
- One or more **Model definitions** as JSON (id, name, contextLength, maxOutputTokens, imageInput, toolCalling, thinking)
- Optional default **Pricing** per 1M tokens

Custom provider metadata is stored in `settings.json` (`shofer.router.customProviders`). API keys are stored in VS Code SecretStorage.

### Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shofer.router.defaultModel` | string | `deepseek-v4-pro` | Default model |
| `shofer.router.timeout` | number | `300000` | Request timeout (ms) |
| `shofer.router.enabled` | boolean | `true` | Enable/disable |
| `shofer.router.debug` | boolean | `false` | Debug logging |
| `shofer.router.compositeModelsFile` | string | `""` | Path to composite-models.json |
| `shofer.router.compositeModelsConfig` | string | `""` | Inline JSON for composite models |
| `shofer.router.customProviders` | string | `""` | Inline JSON for custom providers |

### Composite Models

Define `shofer/*` composite models via the **Config → Composite Models** tab, or in `shofer.router.compositeModelsConfig`:

```json
{
  "shofer/code": {
    "strategy": "failover",
    "models": ["deepseek-v4-pro", "claude-sonnet-4-6", "gpt-5.5"],
    "throttling": { "maxConcurrent": 50, "requestsPerWindow": 100, "windowMinutes": 5 },
    "streamingTimeoutMs": 30000,
    "perAttemptTimeoutMs": 120000,
    "totalTimeoutMs": 600000,
    "health": {
      "failureThreshold": 3,
      "degradedThreshold": 1,
      "cooldownMs": 30000
    }
  },
  "shofer/balanced": {
    "strategy": "round_robin",
    "models": [
      { "id": "deepseek-v4-pro", "weight": 3 },
      { "id": "claude-sonnet-4-6", "weight": 1 }
    ],
    "streamingTimeoutMs": 30000
  },
  "shofer/fastest": {
    "strategy": "lowest_latency",
    "models": ["deepseek-v4-pro", "claude-sonnet-4-6", "gpt-5.5"],
    "latencyWindowMs": 600000
  },
  "shofer/most-reliable": {
    "strategy": "highest_reliability",
    "models": ["deepseek-v4-pro", "claude-sonnet-4-6", "gpt-5.5"],
    "latencyWindowMs": 600000
  }
}
```

**Strategies:**
- **failover**: Tries models in strict order. On failure, falls back to the next.
- **round_robin**: Smooth weighted round-robin (nginx-style) — distributes requests proportional to model weights.
- **lowest_latency**: Always picks the model with the lowest average TTFB over a configurable sliding window. Falls back to equal-weight round-robin on cold start.
- **highest_reliability**: Always picks the model with the highest success ratio over a configurable sliding window (`latencyWindowMs`). Falls back to equal-weight round-robin on cold start.

**Model entries** accept either a plain string (`"model-id"`) or an object with per-model overrides:
- `{ "id": "model-id", "weight": 5 }` — weight for round-robin (default: 1)
- `{ "id": "model-id", "throttling": {...} }` — per-model throttling overrides composite-level defaults

**Health monitoring** (three states, configurable via `health`):
- `healthy` → `degraded` after `degradedThreshold` consecutive failures (still usable)
- `degraded` → `unhealthy` after `failureThreshold` consecutive failures (quarantined)
- Unhealthy models are probed after `cooldownMs` (default: 30s)

**Timeouts:**
- `streamingTimeoutMs` — inactivity timeout for streaming (resets on each chunk, default: 30s)
- `perAttemptTimeoutMs` — hard deadline per attempt for non-streaming (default: 120s)
- `totalTimeoutMs` — total budget across all failovers (default: 300s)

**Capability intersection**: Composite models advertised via VS Code LM API report the minimum `maxInputTokens`/`maxOutputTokens` and the intersection of `imageInput`/`toolCalling`/`promptCache` across all underlying models — safe lower bounds that guarantee failover never hits a capability mismatch.

### Shofer Integration

Shofer's `vscode-lm` provider consumes this extension. Enable it in Shofer:

```json
{
    "shofer.enableLlmProviderIntegration": true
}
```

## Commands

- `Shofer Router: Configure` — Open full configuration dashboard
- `Shofer Router: Show Models` — View status and available models
- `Shofer Router: Refresh Models` — Refresh the model list
- `Shofer Router: Test Connection` — Test API key configuration
- `Shofer Router: Show Metrics` — Multi-chart metrics dashboard
- `Shofer Router: Show Model Stats` — Detailed statistics for a specific model
- `Shofer Router: Export Metrics (Prometheus)` — Export in Prometheus text format
- `Shofer Router: Show Composite Distribution` — Load-balancing distribution for composite models
- `Shofer Router: Show Cost History` — Cost breakdown by model across a selected time range

## Metrics & Observability

Every chat completion request is automatically recorded with per-5-minute window aggregation covering:

- **Cost & tokens by model**: USD cost (from registry pricing), prompt/completion/cached tokens, cache hit ratio
- **Reliability**: TTFB/TTLB latency percentiles (p50/p90/p99), availability %, error-type breakdown
- **Composite load-balancing**: Which underlying model served how many requests, failover counts, attempts
- **Additional KPIs**: Throttle skips, per-window request volume

The webview **Metrics** tab shows all charts on a single page with anchor-link navigation and a categorized model picker that separates Primary from Composite models to prevent double-counting.


## Project Structure

```
extensions/shofer-router/
├── src/
│   ├── main.ts                      # Extension entry point
│   ├── language-model-provider.ts   # VS Code LanguageModelChatProvider + cost ledger
│   ├── llm-client.ts                # HTTP client, SSE streaming, cost computation
│   ├── provider-client.ts           # Provider router + custom provider resolution
│   ├── composite.ts                 # Composite model failover/round-robin/lowest-latency/highest-reliability
│   ├── config-converter.ts          # Webview ↔ host config format conversion
│   ├── model-registry.ts            # All built-in model definitions + pricing
│   ├── metrics-collector.ts         # In-memory 5-min windowed metrics aggregation
│   ├── metrics-storage.ts           # SQLite persistence for metrics
│   ├── secret-storage.ts            # SecretStorage API key + custom provider wrapper
│   ├── router-config-provider.ts    # Webview panel host with message handling
│   ├── logger.ts                    # Structured logging
│   ├── types.ts                     # Shared TypeScript types
│   ├── __tests__/                   # Unit tests
│   └── providers/
│       ├── openai.ts                # GPT-5.x max_completion_tokens remapping
│       ├── anthropic.ts             # Messages API ↔ OpenAI translation
│       ├── google.ts                # Gemini native API
│       ├── deepseek.ts              # Reasoning_content round-trip
│       ├── minimax.ts               # <think> tag handling
│       ├── moonshot.ts              # Kimi reasoning content
│       ├── xiaomi.ts                # MiMo thinking injection
│       ├── zhipu.ts                 # GLM thinking toggle
│       └── openrouter.ts            # Passthrough fallback
├── webview-ui/
│   └── src/
│       ├── App.tsx                  # Tab routing (Status, Config, Metrics, Help)
│       └── components/
│           ├── ProvidersPanel.tsx    # Built-in + custom provider config
│           ├── CompositeEditor.tsx   # Composite model edition with latency UI
│           ├── CompositeList.tsx     # Composite model list with +New / 🗑
│           ├── ConfigEditor.tsx      # Two-panel config editor
│           ├── ConfigPanel.tsx       # Sub-tab bar (Primary Providers / Composite)
│           ├── MetricsPanel.tsx      # Multi-chart dashboard with categorized picker
│           ├── HelpPanel.tsx         # Usage guide
│           ├── StrategySelector.tsx  # failover / round_robin / lowest_latency / highest_reliability
│           └── ...
├── package.json
├── tsconfig.json
├── BUILD.bazel
├── README.md
└── DESIGN.md
```

## Architecture

```
Shofer (vscode-lm handler)
    │
    ├─ vscode.lm.selectChatModels({vendor:"shofer"})
    │    → LanguageModelProvider registers all models from registry + custom providers
    │
    ├─ client.sendRequest(messages, options)
    │    → ProviderRouter resolves model → built-in provider or custom provider
    │    → Custom providers: protocol-based handler factory
    │    → Provider-specific request preparation (Anthropic translation, etc.)
    │    → Direct HTTP/SSE call to provider API (OpenAI, Anthropic, etc.)
    │
    ├─ Composite models (shofer/*)
    │    → CompositeService: failover / round_robin / lowest_latency / highest_reliability
    │    → TTFB EMA tracking per model (lowest_latency)
    │    → Success-ratio tracking per model (highest_reliability)
    │    → In-process health tracking + throttling
    │
    └─ Side-channel commands:
         shofer.llm.getModelPricing(modelId)    → Registry + custom provider pricing
         shofer.llm.getModelCapabilities(modelId) → Capabilities
         shofer.llm.getRequestCost(conversationId) → Per-conversation cost ledger
```

## License

AGPL-3.0 — see [LICENSE](LICENSE) for the full text.
