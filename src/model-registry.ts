/**
 * Model registry — single source of truth for all model metadata.
 *
 * Prices are stored as USD per 1K tokens (matching the Go source);
 * the llm-client converts to per-1M-token form for Shofer compatibility.
 */

import { ModelRegistryEntry, ModelPricing, ProviderType } from './types';

// ─── Helper: per-1K-token prices ─────────────────────────────────────

const $ = (prompt: number, completion: number, cacheRead?: number, cacheWrite?: number, discount?: number): ModelPricing => {
    const p: ModelPricing = { prompt, completion };
    if (cacheRead !== undefined) p.contextCacheRead = cacheRead;
    if (cacheWrite !== undefined) p.contextCacheWrite = cacheWrite;
    if (discount !== undefined) p.discount = discount;
    return p;
};

// ─── The registry ────────────────────────────────────────────────────

export const ALL_MODELS: ModelRegistryEntry[] = [
    // ═══ OpenAI ═══
    {
        id: 'gpt-5.5', name: 'GPT-5.5',
        description: "OpenAI's flagship model — a new class of intelligence for coding and professional work, with adjustable reasoning effort",
        contextLength: 1_000_000, maxOutputTokens: 131_072,
        provider: ProviderType.OpenAI,
        pricing: $(0.005, 0.030, 0.0005, undefined, 0.5),
        imageInput: true, toolCalling: true,
    },
    {
        id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro',
        description: "OpenAI's deepest-reasoning model in the GPT-5.5 family for the hardest professional and research workloads",
        contextLength: 1_000_000, maxOutputTokens: 131_072,
        provider: ProviderType.OpenAI,
        pricing: $(0.030, 0.180),
        imageInput: true, toolCalling: true,
    },
    {
        id: 'gpt-5.4', name: 'GPT-5.4',
        description: "OpenAI's affordable flagship for coding and professional work with 1M context and adjustable reasoning effort",
        contextLength: 1_000_000, maxOutputTokens: 131_072,
        provider: ProviderType.OpenAI,
        pricing: $(0.0025, 0.015, 0.00025, undefined, 0.5),
        imageInput: true, toolCalling: true,
    },
    {
        id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini',
        description: "OpenAI's strongest mini model for coding, computer use, and subagents with 400K context",
        contextLength: 400_000, maxOutputTokens: 131_072,
        provider: ProviderType.OpenAI,
        pricing: $(0.00075, 0.0045, 0.000075, undefined, 0.5),
        imageInput: true, toolCalling: true,
    },
    {
        id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano',
        description: "OpenAI's most cost-efficient GPT-5 model for high-volume tasks with 400K context",
        contextLength: 400_000, maxOutputTokens: 131_072,
        provider: ProviderType.OpenAI,
        pricing: $(0.0002, 0.00125, 0.00002, undefined, 0.5),
        imageInput: true, toolCalling: true,
    },

    // ═══ Anthropic ═══
    {
        id: 'claude-opus-4-8', name: 'Claude Opus 4.8',
        description: "Anthropic's most capable generally available model (Opus 4.8) for complex reasoning and agentic coding, with adaptive thinking and 1M context",
        contextLength: 1_000_000, maxOutputTokens: 131_072,
        provider: ProviderType.Anthropic,
        pricing: $(0.005, 0.025, 0.0005, 0.00625, 0.5),
        imageInput: true, toolCalling: true,
    },
    {
        id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6',
        description: "Anthropic's best balance of speed and intelligence with extended/adaptive thinking and 1M context",
        contextLength: 1_000_000, maxOutputTokens: 65_536,
        provider: ProviderType.Anthropic,
        pricing: $(0.003, 0.015, 0.0003, 0.00375, 0.5),
        imageInput: true, toolCalling: true,
    },
    {
        id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5',
        description: "Anthropic's fastest model with near-frontier intelligence, extended thinking, and 200K context",
        contextLength: 200_000, maxOutputTokens: 65_536,
        provider: ProviderType.Anthropic,
        pricing: $(0.001, 0.005, 0.0001, 0.00125, 0.5),
        imageInput: true, toolCalling: true,
    },

    // ═══ Google Gemini ═══
    {
        id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview',
        description: "Google's latest flagship thinking model for multimodal understanding, agentic coding, and precise tool usage. 1M context.",
        contextLength: 1_048_576, maxOutputTokens: 65_536,
        provider: ProviderType.Google,
        pricing: { prompt: 0.002, completion: 0.012, promptAbove200K: 0.004, completionAbove200K: 0.018, contextCacheRead: 0.0002, discount: 0.5 },
        imageInput: true, toolCalling: true,
    },
    {
        id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview',
        description: "Google's most intelligent model built for speed, combining frontier intelligence with superior search, grounding, and computer use. 1M context.",
        contextLength: 1_048_576, maxOutputTokens: 65_536,
        provider: ProviderType.Google,
        pricing: { prompt: 0.0005, completion: 0.003, audioPrompt: 0.001, contextCacheRead: 0.00005, discount: 0.5 },
        imageInput: true, toolCalling: true,
    },
    {
        id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash-Lite Preview',
        description: "Google's most cost-efficient model for high-volume agentic tasks. 1M context.",
        contextLength: 1_048_576, maxOutputTokens: 65_536,
        provider: ProviderType.Google,
        pricing: { prompt: 0.00025, completion: 0.0015, audioPrompt: 0.0005, contextCacheRead: 0.000025, discount: 0.5 },
        imageInput: true, toolCalling: true,
    },

    // ═══ DeepSeek ═══
    {
        id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro',
        description: 'DeepSeek V4 Pro: 1.6T total / 49B active params, world-class reasoning and agentic coding.',
        contextLength: 1_000_000, maxOutputTokens: 65_536,
        provider: ProviderType.DeepSeek,
        // 75% promotional discount (until 2026-05-31); update when it expires
        pricing: $(0.000435, 0.00087, 0.000003625),
        imageInput: false, toolCalling: true,
    },
    {
        id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash',
        description: 'DeepSeek V4 Flash: 284B total / 13B active params, fast and cost-effective.',
        contextLength: 1_000_000, maxOutputTokens: 65_536,
        provider: ProviderType.DeepSeek,
        pricing: $(0.00014, 0.00028),
        imageInput: false, toolCalling: true,
    },

    // ═══ MiniMax ═══
    {
        id: 'MiniMax-M2.7', name: 'MiniMax M2.7',
        description: 'MiniMax M2.7 model',
        contextLength: 200_000, maxOutputTokens: 32_768,
        provider: ProviderType.MiniMax,
        pricing: $(0.0003, 0.0012, 0.00006, 0.000375),
        imageInput: false, toolCalling: true,
    },
    {
        id: 'MiniMax-M2.5', name: 'MiniMax M2.5',
        description: 'MiniMax M2.5 model',
        contextLength: 204_800, maxOutputTokens: 32_768,
        provider: ProviderType.MiniMax,
        pricing: $(0.0003, 0.0012, 0.00003, 0.000375),
        imageInput: false, toolCalling: true,
    },

    // ═══ Moonshot / Kimi ═══
    {
        id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking',
        description: 'Moonshot Kimi K2 Thinking model',
        contextLength: 256_000, maxOutputTokens: 32_768,
        provider: ProviderType.Moonshot,
        pricing: $(0.0006, 0.0025, 0.00015),
        imageInput: false, toolCalling: true,
    },
    {
        id: 'kimi-k2.5', name: 'Kimi K2.5',
        description: 'Moonshot Kimi K2.5 model',
        contextLength: 256_000, maxOutputTokens: 32_768,
        provider: ProviderType.Moonshot,
        pricing: $(0.0006, 0.003, 0.0001),
        imageInput: true, toolCalling: true,
    },

    // ═══ Xiaomi MiMo ═══
    {
        id: 'mimo-v2-pro', name: 'MiMo v2 Pro',
        description: 'Xiaomi MiMo v2 Pro with thinking enabled',
        contextLength: 1_000_000, maxOutputTokens: 131_072,
        provider: ProviderType.Xiaomi,
        pricing: { prompt: 0.001, completion: 0.003, contextCacheRead: 0.0002, promptAbove200K: 0.002, completionAbove200K: 0.006 },
        imageInput: false, toolCalling: true,
    },
    {
        id: 'mimo-v2-omni', name: 'MiMo v2 Omni',
        description: 'Xiaomi MiMo v2 Omni-modal model with thinking',
        contextLength: 256_000, maxOutputTokens: 32_768,
        provider: ProviderType.Xiaomi,
        pricing: $(0.0004, 0.002, 0.00008),
        imageInput: true, toolCalling: true,
    },
    {
        id: 'mimo-v2-tts', name: 'MiMo v2 TTS',
        description: 'Xiaomi MiMo v2 Text-to-Speech model',
        contextLength: 8_192, maxOutputTokens: 8_192,
        provider: ProviderType.Xiaomi,
        pricing: {}, // TTS billed per character, not per token
        imageInput: false, toolCalling: false,
    },
    {
        id: 'mimo-v2-flash', name: 'MiMo v2 Flash',
        description: 'Xiaomi MiMo v2 Flash model',
        contextLength: 256_000, maxOutputTokens: 65_536,
        provider: ProviderType.Xiaomi,
        pricing: $(0.0001, 0.0003, 0.00001),
        imageInput: false, toolCalling: true,
    },

    // ═══ Zhipu GLM ═══
    {
        id: 'glm-5.2', name: 'GLM-5.2',
        description: 'Zhipu AI GLM-5.2 next-gen flagship for agentic engineering with interleaved thinking and long-horizon optimization',
        contextLength: 1_000_000, maxOutputTokens: 131_072,
        provider: ProviderType.Zhipu,
        pricing: $(0.0025, 0.005),
        imageInput: false, toolCalling: true,
    },
    {
        id: 'glm-5.1', name: 'GLM-5.1',
        description: 'Zhipu AI GLM-5.1 next-gen flagship for agentic engineering with long-horizon optimization',
        contextLength: 200_000, maxOutputTokens: 131_072,
        provider: ProviderType.Zhipu,
        pricing: $(0.002, 0.004),
        imageInput: false, toolCalling: true,
    },
    {
        id: 'glm-5', name: 'GLM-5',
        description: 'Zhipu AI GLM-5 flagship model with interleaved thinking',
        contextLength: 200_000, maxOutputTokens: 131_072,
        provider: ProviderType.Zhipu,
        pricing: $(0.001, 0.002),
        imageInput: false, toolCalling: true,
    },
    {
        id: 'glm-4.7', name: 'GLM-4.7',
        description: 'Zhipu AI GLM-4.7 with turn-level thinking',
        contextLength: 200_000, maxOutputTokens: 131_072,
        provider: ProviderType.Zhipu,
        pricing: $(0.0008, 0.0016),
        imageInput: false, toolCalling: true,
    },
    {
        id: 'glm-4.6', name: 'GLM-4.6',
        description: 'Zhipu AI GLM-4.6 with hybrid thinking',
        contextLength: 200_000, maxOutputTokens: 131_072,
        provider: ProviderType.Zhipu,
        pricing: $(0.0006, 0.0012),
        imageInput: false, toolCalling: true,
    },
    {
        id: 'glm-4.5', name: 'GLM-4.5',
        description: 'Zhipu AI GLM-4.5 with interleaved thinking',
        contextLength: 200_000, maxOutputTokens: 131_072,
        provider: ProviderType.Zhipu,
        pricing: $(0.0005, 0.001),
        imageInput: false, toolCalling: true,
    },
    // ═══ Mistral ═══
    {
        id: 'mistral-large-latest', name: 'Mistral Large',
        description: "Mistral's flagship model for complex reasoning and agentic coding with native function calling",
        contextLength: 262_144, maxOutputTokens: 131_072,
        provider: ProviderType.Mistral,
        pricing: $(0.002, 0.006),
        imageInput: true, toolCalling: true,
    },
    {
        id: 'codestral-latest', name: 'Codestral',
        description: "Mistral's specialized coding model optimized for code generation and completion",
        contextLength: 262_144, maxOutputTokens: 131_072,
        provider: ProviderType.Mistral,
        pricing: $(0.001, 0.003),
        imageInput: false, toolCalling: true,
    },
    {
        id: 'pixtral-large-latest', name: 'Pixtral Large',
        description: "Mistral's multimodal model with vision capabilities",
        contextLength: 131_072, maxOutputTokens: 131_072,
        provider: ProviderType.Mistral,
        pricing: $(0.002, 0.006),
        imageInput: true, toolCalling: true,
    },

    // ═══ xAI ═══
    {
        id: 'grok-4', name: 'Grok 4',
        description: "xAI's flagship large language model for reasoning and coding",
        contextLength: 1_000_000, maxOutputTokens: 131_072,
        provider: ProviderType.XAI,
        pricing: $(0.003, 0.015),
        imageInput: true, toolCalling: true,
    },
    {
        id: 'grok-4-mini', name: 'Grok 4 Mini',
        description: "xAI's small, fast model for efficient reasoning and coding tasks",
        contextLength: 1_000_000, maxOutputTokens: 131_072,
        provider: ProviderType.XAI,
        pricing: $(0.0006, 0.003),
        imageInput: true, toolCalling: true,
    },

    // ═══ AWS Bedrock ═══
    {
        id: 'anthropic.claude-sonnet-4-20250514-v1:0', name: 'Bedrock Claude Sonnet 4',
        description: 'AWS Bedrock Claude Sonnet 4 via Converse API',
        contextLength: 200_000, maxOutputTokens: 65_536,
        provider: ProviderType.Bedrock,
        pricing: $(0.003, 0.015, 0.0003, 0.00375),
        imageInput: true, toolCalling: true,
    },
    {
        id: 'anthropic.claude-opus-4-20250514-v1:0', name: 'Bedrock Claude Opus 4',
        description: 'AWS Bedrock Claude Opus 4 via Converse API',
        contextLength: 200_000, maxOutputTokens: 65_536,
        provider: ProviderType.Bedrock,
        pricing: $(0.015, 0.075, 0.0015, 0.01875),
        imageInput: true, toolCalling: true,
    },

    // ═══ Vertex AI (Gemini) ═══
    // Note: These share the same model IDs as Google Gemini — the provider
    // routing distinguishes by ProviderType, not model ID. The index below
    // prefers the first (Google) entry for bare-ID lookups; Vertex entries
    // are accessible via "vertex/gemini-3-pro-preview" key form.
    {
        id: 'gemini-3-pro-preview', name: 'Vertex Gemini 3 Pro',
        description: 'Google Vertex AI Gemini 3 Pro model for thinking and agentic coding',
        contextLength: 1_048_576, maxOutputTokens: 65_536,
        provider: ProviderType.Vertex,
        pricing: { prompt: 0.002, completion: 0.012, promptAbove200K: 0.004, completionAbove200K: 0.018, contextCacheRead: 0.0002, discount: 0.5 },
        imageInput: true, toolCalling: true,
    },
    {
        id: 'gemini-3-flash-preview', name: 'Vertex Gemini 3 Flash',
        description: 'Google Vertex AI Gemini 3 Flash for speed with frontier intelligence',
        contextLength: 1_048_576, maxOutputTokens: 65_536,
        provider: ProviderType.Vertex,
        pricing: { prompt: 0.0005, completion: 0.003, contextCacheRead: 0.00005, discount: 0.5 },
        imageInput: true, toolCalling: true,
    },

    // ═══ Anthropic Vertex ═══
    {
        id: 'claude-sonnet-4-20250514', name: 'Vertex Claude Sonnet 4',
        description: 'Anthropic Claude Sonnet 4 via Google Cloud Vertex AI',
        contextLength: 200_000, maxOutputTokens: 65_536,
        provider: ProviderType.AnthropicVertex,
        pricing: $(0.003, 0.015, 0.0003, 0.00375),
        imageInput: true, toolCalling: true,
    },
    {
        id: 'claude-opus-4-20250514', name: 'Vertex Claude Opus 4',
        description: 'Anthropic Claude Opus 4 via Google Cloud Vertex AI',
        contextLength: 200_000, maxOutputTokens: 65_536,
        provider: ProviderType.AnthropicVertex,
        pricing: $(0.015, 0.075, 0.0015, 0.01875),
        imageInput: true, toolCalling: true,
    },

    // ═══ Ollama ═══
    {
        id: 'llama4-maverick', name: 'Llama 4 Maverick',
        description: 'Meta Llama 4 Maverick (via Ollama) — 17B active params, MoE architecture',
        contextLength: 131_072, maxOutputTokens: 16_384,
        provider: ProviderType.Ollama,
        pricing: { prompt: 0, completion: 0 },
        imageInput: false, toolCalling: true,
    },
    {
        id: 'qwen3-coder', name: 'Qwen 3 Coder',
        description: 'Alibaba Qwen 3 Coder (via Ollama) — specialized for code generation',
        contextLength: 131_072, maxOutputTokens: 16_384,
        provider: ProviderType.Ollama,
        pricing: { prompt: 0, completion: 0 },
        imageInput: false, toolCalling: true,
    },

    // ═══ LM Studio ═══
    {
        id: 'lmstudio-default', name: 'LM Studio Model',
        description: 'Local model hosted by LM Studio (OpenAI-compatible)',
        contextLength: 131_072, maxOutputTokens: 16_384,
        provider: ProviderType.LmStudio,
        pricing: { prompt: 0, completion: 0 },
        imageInput: false, toolCalling: true,
    },

    // ═══ Fireworks AI ═══
    {
        id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', name: 'Llama 3.3 70B (Fireworks)',
        description: 'Meta Llama 3.3 70B via Fireworks AI — fast, cost-effective inference',
        contextLength: 131_072, maxOutputTokens: 16_384,
        provider: ProviderType.Fireworks,
        pricing: $(0.0009, 0.0009),
        imageInput: false, toolCalling: true,
    },
    {
        id: 'accounts/fireworks/models/deepseek-v3', name: 'DeepSeek V3 (Fireworks)',
        description: 'DeepSeek V3 via Fireworks AI',
        contextLength: 131_072, maxOutputTokens: 16_384,
        provider: ProviderType.Fireworks,
        pricing: $(0.001, 0.001),
        imageInput: false, toolCalling: true,
    },

    // ═══ SambaNova ═══
    {
        id: 'Meta-Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B (SambaNova)',
        description: 'Meta Llama 3.3 70B via SambaNova — high throughput inference',
        contextLength: 131_072, maxOutputTokens: 16_384,
        provider: ProviderType.SambaNova,
        pricing: $(0.0006, 0.0012),
        imageInput: false, toolCalling: true,
    },
    {
        id: 'DeepSeek-V3-0324', name: 'DeepSeek V3 (SambaNova)',
        description: 'DeepSeek V3 via SambaNova',
        contextLength: 131_072, maxOutputTokens: 16_384,
        provider: ProviderType.SambaNova,
        pricing: $(0.001, 0.001),
        imageInput: false, toolCalling: true,
    },

    // ═══ Baseten ═══
    {
        id: 'deepseek-r1', name: 'DeepSeek R1 (Baseten)',
        description: 'DeepSeek R1 reasoning model via Baseten inference',
        contextLength: 131_072, maxOutputTokens: 16_384,
        provider: ProviderType.Baseten,
        pricing: $(0.001, 0.001),
        imageInput: false, toolCalling: true,
    },

    // ═══ Requesty ═══
    {
        id: 'requesty-default', name: 'Requesty Router',
        description: 'Requesty LLM router — proxies to multiple underlying providers',
        contextLength: 200_000, maxOutputTokens: 32_768,
        provider: ProviderType.Requesty,
        pricing: $(0.001, 0.003),
        imageInput: true, toolCalling: true,
    },

    // ═══ Unbound ═══
    {
        id: 'unbound-default', name: 'Unbound Router',
        description: 'Unbound LLM router — proxies to multiple underlying providers',
        contextLength: 200_000, maxOutputTokens: 32_768,
        provider: ProviderType.Unbound,
        pricing: $(0.001, 0.003),
        imageInput: true, toolCalling: true,
    },

    // ═══ Vercel AI Gateway ═══
    {
        id: 'vercel-ai-gateway-default', name: 'Vercel AI Gateway',
        description: 'Vercel AI Gateway — proxies to multiple underlying providers',
        contextLength: 200_000, maxOutputTokens: 32_768,
        provider: ProviderType.VercelAiGateway,
        pricing: $(0.001, 0.003),
        imageInput: true, toolCalling: true,
    },

    // ═══ Z.ai ═══
    {
        id: 'glm-5.2-zai', name: 'GLM-5.2 (Z.ai)',
        description: 'Zhipu GLM-5.2 via Z.ai international API with interleaved thinking',
        contextLength: 1_000_000, maxOutputTokens: 131_072,
        provider: ProviderType.ZAi,
        pricing: $(0.0025, 0.005),
        imageInput: false, toolCalling: true,
    },
    {
        id: 'glm-4.7-zai', name: 'GLM-4.7 (Z.ai)',
        description: 'Zhipu GLM-4.7 via Z.ai international API with turn-level thinking',
        contextLength: 200_000, maxOutputTokens: 131_072,
        provider: ProviderType.ZAi,
        pricing: $(0.0008, 0.0016),
        imageInput: false, toolCalling: true,
    },
    {
        id: 'glm-5-zai', name: 'GLM-5 (Z.ai)',
        description: 'Zhipu GLM-5 via Z.ai international API with interleaved thinking',
        contextLength: 200_000, maxOutputTokens: 131_072,
        provider: ProviderType.ZAi,
        pricing: $(0.001, 0.002),
        imageInput: false, toolCalling: true,
    },
];

// ─── Lookup helpers ──────────────────────────────────────────────────

const modelIndex = new Map<string, ModelRegistryEntry>();
for (const m of ALL_MODELS) {
    // Index by bare id only once (first entry wins) so duplicates from
    // different providers (e.g. Vertex sharing Google model IDs) don't
    // silently clobber the primary entry.
    if (!modelIndex.has(m.id)) {
        modelIndex.set(m.id, m);
    }
    // Always index by "provider/id" form for full disambiguation.
    modelIndex.set(`${m.provider}/${m.id}`, m);
}

export function getModelById(modelId: string): ModelRegistryEntry | undefined {
    // Try exact match
    const direct = modelIndex.get(modelId);
    if (direct) return direct;

    // Try extracting model from "provider/model" format
    const slashIdx = modelId.lastIndexOf('/');
    if (slashIdx !== -1) {
        const shortId = modelId.substring(slashIdx + 1);
        return modelIndex.get(shortId);
    }

    return undefined;
}

export function getModelsByProvider(provider: ProviderType): ModelRegistryEntry[] {
    return ALL_MODELS.filter(m => m.provider === provider);
}

export function isValidModel(modelId: string): boolean {
    return getModelById(modelId) !== undefined;
}

/** Derive provider from model ID via the registry. */
export function getProviderForModel(modelId: string): ProviderType | undefined {
    return getModelById(modelId)?.provider;
}
