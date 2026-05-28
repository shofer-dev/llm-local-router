# Shofer LLM Router

A VS Code extension that provides **direct access to multiple LLM providers** with **composite model failover** — no external router service required. This extension consolidates the functionality previously split across `llm-router` (Go microservice) and `llm-provider` (VS Code extension bridge) into a single self-contained extension.

## What It Does

llm-provider required a running llm-router server (`localhost:30081`) to function. Shofer LLM Router eliminates that dependency by talking directly to each provider's API from within the VS Code extension host.

| Concern | Previously | Now |
|---------|-----------|-----|
| Provider API access | llm-router (Go service) | Direct from extension |
| VS Code LM integration | llm-provider bridge | Built-in |
| Composite model failover | llm-router | Built-in (in-process) |
| API key storage | llm-router `.env` file | VS Code SecretStorage |
| Redis caching | Required (llm-router) | None needed |
| Prompt caching | Redis-backed | N/A (direct API calls) |
| Reasoning cache | Redis-backed | Placeholder-based fallback |

## Features

- **9 LLM providers**: OpenAI, Anthropic, Google Gemini, DeepSeek, MiniMax, Moonshot/Kimi, Xiaomi MiMo, Zhipu GLM, OpenRouter
- **Composite models** (`shofer/*`): Failover and round-robin strategies across multiple underlying models with in-process health monitoring and throttling
- **Full protocol translation**: Anthropic Messages API ↔ OpenAI Chat Completions, MiniMax `<think>` tag handling, DeepSeek/Moonshot reasoning_content round-trip, Xiaomi max_completion_tokens remapping, Zhipu thinking toggle
- **Streaming**: SSE streaming for all providers with real-time tool call accumulation
- **Cost tracking**: Per-token pricing from the built-in model registry, per-conversation cost ledger
- **VS Code LM API**: Implements `LanguageModelChatProvider` for Copilot and Shofer integration
- **Side-channel commands**: `shofer.llm.getModelPricing`, `shofer.llm.getModelCapabilities`, `shofer.llm.getRequestCost`
- **Secure API keys**: Stored via VS Code's `SecretStorage` API

## Requirements

- VS Code 1.100.0 or later
- API keys for at least one supported provider

## Supported Providers

| Provider | Models | API Key |
|----------|--------|---------|
| OpenAI | gpt-5.5, gpt-5.5-pro, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano | `openai` |
| Anthropic | claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5 | `anthropic` |
| Google | gemini-3.1-pro-preview, gemini-3-flash-preview, gemini-3.1-flash-lite-preview | `google` |
| DeepSeek | deepseek-v4-pro, deepseek-v4-flash | `deepseek` |
| MiniMax | MiniMax-M2.7, MiniMax-M2.5 | `minimax` |
| Moonshot | kimi-k2-thinking, kimi-k2.5 | `moonshot` |
| Xiaomi | mimo-v2-pro, mimo-v2-omni, mimo-v2-tts, mimo-v2-flash | `xiaomi` |
| Zhipu | glm-5.1, glm-5, glm-4.7, glm-4.6, glm-4.5 | `zhipu` |
| OpenRouter | auto (passthrough for unknown models) | `openrouter` |

## Configuration

### Provider API Keys

API keys are stored securely using VS Code's `SecretStorage`. Use the VS Code command palette to set them:

1. Open Command Palette (`Ctrl+Shift+P`)
2. Run `Shofer LLM Router: Configure`
3. Set API keys in VS Code settings under `shofer.router.*`

The extension reads keys from SecretStorage under the keys `shofer-router.provider.{name}` (e.g., `shofer-router.provider.openai`).

### Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shofer.router.defaultModel` | string | `deepseek-v4-pro` | Default model |
| `shofer.router.timeout` | number | `300000` | Request timeout (ms) |
| `shofer.router.enabled` | boolean | `true` | Enable/disable |
| `shofer.router.debug` | boolean | `false` | Debug logging |
| `shofer.router.compositeModelsFile` | string | `""` | Path to composite-models.json |

### Composite Models

Define `shofer/*` composite models in a JSON file referenced by `shofer.router.compositeModelsFile`:

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
  "shofer/budget": {
    "strategy": "failover",
    "models": [
      { "id": "gpt-5.4-nano", "throttling": { "maxConcurrent": 5, "requestsPerWindow": 20, "windowMinutes": 5 } },
      "deepseek-v4-flash"
    ]
  }
}
```

**Strategies:**
- **failover**: Tries models in strict order. On failure, falls back to the next.
- **round_robin**: Smooth weighted round-robin (nginx-style) — distributes requests proportional to model weights without bursting.

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

- `Shofer LLM Router: Configure` — Open extension settings
- `Shofer LLM Router: Show Models` — Display all available models
- `Shofer LLM Router: Refresh Models` — Refresh the model list
- `Shofer LLM Router: Test Connection` — Test API key configuration

## Project Structure

```
extensions/shofer-router/
├── src/
│   ├── main.ts                      # Extension entry point
│   ├── language-model-provider.ts   # VS Code LanguageModelChatProvider + cost ledger
│   ├── llm-client.ts                # HTTP client, SSE streaming, cost computation
│   ├── provider-client.ts           # Provider router and factory
│   ├── composite.ts                 # Composite model failover/round-robin
│   ├── model-registry.ts            # All model definitions + pricing
│   ├── secret-storage.ts            # SecretStorage API key wrapper
│   ├── logger.ts                    # Structured logging
│   ├── types.ts                     # Shared TypeScript types
│   └── providers/
│       ├── openai.ts                # GPT-5.x max_completion_tokens remapping
│       ├── anthropic.ts             # Messages API ↔ OpenAI translation
│       ├── google.ts                # Gemini passthrough
│       ├── deepseek.ts              # Reasoning_content round-trip
│       ├── minimax.ts               # <think> tag handling
│       ├── moonshot.ts              # Kimi reasoning content
│       ├── xiaomi.ts                # MiMo thinking injection
│       ├── zhipu.ts                 # GLM thinking toggle
│       └── openrouter.ts            # Passthrough fallback
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
    │    → LanguageModelProvider registers all models from built-in registry
    │
    ├─ client.sendRequest(messages, options)
    │    → ProviderRouter resolves model → provider
    │    → Provider-specific request preparation (Anthropic translation, etc.)
    │    → Direct HTTP/SSE call to provider API (OpenAI, Anthropic, etc.)
    │
    ├─ Composite models (shofer/*)
    │    → CompositeService: failover / round-robin across underlying models
    │    → In-process health tracking + throttling
    │
    └─ Side-channel commands:
         shofer.llm.getModelPricing(modelId)    → Built-in registry pricing
         shofer.llm.getModelCapabilities(modelId) → Built-in registry capabilities
         shofer.llm.getRequestCost(conversationId) → Per-conversation cost ledger
```

## Differences from llm-provider + llm-router

| Aspect | Old (llm-provider + llm-router) | New (shofer-router) |
|--------|----------------------------------|---------------------|
| **Dependencies** | Requires running llm-router Go service + Redis | Self-contained VS Code extension |
| **API keys** | Centralized in llm-router `.env` | Per-user in VS Code SecretStorage |
| **Prompt caching** | Redis-backed | Not needed (direct API calls) |
| **Rate limiting** | Redis-backed distributed | In-process per-instance throttling |
| **Reasoning cache** | Redis-backed | Placeholder injection fallback |
| **Metrics** | Prometheus + OpenTelemetry | VS Code output channel logging |
| **Multi-tenant** | Yes (shared service) | No (per-user extension) |
| **Model registry** | Go source in llm-router | TypeScript source in extension |

## License

MIT
