/**
 * Provider client factory and routing logic.
 *
 * Selects the correct provider based on model ID, applies provider-specific
 * request transformations, and routes to the correct API endpoint with the
 * correct API key.
 *
 * Supports both built-in providers (ProviderType enum) and user-registered
 * custom providers (openai-compatible, anthropic-compatible, google-compatible).
 */

import {
    ProviderType,
    ProviderApiKeys,
    ProviderClient,
    ChatCompletionRequest,
    ChatCompletionResponse,
    CompositeModelConfig,
    CustomProviderConfig,
    CustomProviderModel,
} from './types';
import { getProviderForModel } from './model-registry';
import {
    sendNonStreamingRequest,
    sendStreamingRequest,
} from './llm-client';
import { getLogger } from './logger';
import {
    prepareAnthropicRequest,
} from './providers/anthropic';
import { prepareOpenAIRequest } from './providers/openai';
import { prepareDeepSeekRequest, transformDeepSeekStreamChunk } from './providers/deepseek';
import { prepareMiniMaxRequest, transformMiniMaxStreamChunk } from './providers/minimax';
import { prepareMoonshotRequest } from './providers/moonshot';
import { prepareXiaomiRequest } from './providers/xiaomi';
import { prepareZhipuRequest } from './providers/zhipu';
import { prepareDashScopeRequest } from './providers/dashscope';
import {
    sendGeminiStreamingRequest,
    sendGeminiNonStreamingRequest,
} from './providers/google';
import { prepareBedrockRequest } from './providers/bedrock';
import { prepareVertexRequest } from './providers/vertex';
import { prepareZAiRequest } from './providers/zai';

/**
 * Shared no-op request preparer for plain OpenAI-compatible providers that need
 * no request transformation (their base URLs live in PROVIDER_BASE_URLS).
 */
const noopPreparer = (_req: ChatCompletionRequest): void => { /* no transformation needed */ };

// ─── Provider endpoint configuration ───────────────────────────────

const PROVIDER_BASE_URLS: Record<ProviderType, string> = {
    [ProviderType.OpenAI]: 'https://api.openai.com/v1',
    [ProviderType.Anthropic]: 'https://api.anthropic.com/v1',
    [ProviderType.Google]: 'https://generativelanguage.googleapis.com/v1beta',
    [ProviderType.DeepSeek]: 'https://api.deepseek.com/v1',
    [ProviderType.MiniMax]: 'https://api.minimax.io/v1',
    // Global/international host (never the .cn regional endpoint). Override
    // per-instance via the Config panel's endpoint field to reach the
    // Kimi-for-Coding subscription plane (https://api.kimi.com/coding/v1, K3).
    [ProviderType.Moonshot]: 'https://api.moonshot.ai/v1',
    [ProviderType.Xiaomi]: 'https://api.xiaomimimo.com/v1',
    // GLM models routed via the Z.ai international Coding Plan endpoint
    // (not bigmodel.cn) so a Z.ai coding-plan key serves the bare glm-* models.
    [ProviderType.Zhipu]: 'https://api.z.ai/api/coding/paas/v4',
    [ProviderType.OpenRouter]: 'https://openrouter.ai/api/v1',
    [ProviderType.Mistral]: 'https://api.mistral.ai/v1',
    [ProviderType.XAI]: 'https://api.x.ai/v1',
    [ProviderType.Bedrock]: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    [ProviderType.Vertex]: 'https://us-central1-aiplatform.googleapis.com/v1',
    [ProviderType.AnthropicVertex]: 'https://us-central1-aiplatform.googleapis.com/v1',
    [ProviderType.Ollama]: 'http://localhost:11434/v1',
    [ProviderType.LmStudio]: 'http://localhost:1234/v1',
    [ProviderType.Fireworks]: 'https://api.fireworks.ai/inference/v1',
    [ProviderType.SambaNova]: 'https://api.sambanova.ai/v1',
    [ProviderType.Baseten]: 'https://inference.baseten.co/v1',
    [ProviderType.Requesty]: 'https://api.requesty.ai/v1',
    [ProviderType.Unbound]: 'https://api.getunbound.ai/v1',
    [ProviderType.VercelAiGateway]: 'https://ai-gateway.vercel.sh/v1',
    [ProviderType.ZAi]: 'https://api.z.ai/api/coding/paas/v4',
    // Alibaba DashScope (Qwen) — OpenAI-compatible. International (Singapore)
    // endpoint by default; override per-instance via endpointUrls (e.g. the
    // Beijing host https://dashscope.aliyuncs.com/compatible-mode/v1).
    [ProviderType.DashScope]: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
};

/**
 * Provider-specific request preparation.
 * Some providers need message/parameter transformations before sending.
 */
type RequestPreparer = (req: ChatCompletionRequest) => void;
type StreamChunkTransformer = (chunk: ChatCompletionResponse) => void;

interface ProviderHandler {
    preparer: RequestPreparer;
    chunkTransformer?: StreamChunkTransformer;
    /** If true, this provider uses a non-OpenAI-compatible API (e.g., Anthropic) */
    customSend?: (
        apiKey: string,
        req: ChatCompletionRequest,
        onChunk: (chunk: ChatCompletionResponse) => void,
        abortController: AbortController,
    ) => Promise<ChatCompletionResponse>;
}

// ─── Provider router ─────────────────────────────────────────────────

export class ProviderRouter {
    private apiKeys: ProviderApiKeys = {};
    /** API keys for custom providers (providerId → key). */
    private customApiKeys: Record<string, string> = {};
    private endpointUrls: Record<string, string> = {};
    private compositeModels: Record<string, CompositeModelConfig> = {};
    /** Registry of user-registered custom primary providers. */
    private customProviders: Map<string, CustomProviderConfig> = new Map();
    /** Reverse index: model ID → custom provider ID. */
    private customModelIndex: Map<string, string> = new Map();
    private handlerCache = new Map<ProviderType, ProviderHandler>();

    constructor() {
        this.initHandlers();
    }

    private initHandlers(): void {
        // OpenAI: remap max_tokens→max_completion_tokens for o-series/GPT-5.x
        this.handlerCache.set(ProviderType.OpenAI, {
            preparer: prepareOpenAIRequest,
        });

        // Anthropic: full Messages API translation (custom send path)
        this.handlerCache.set(ProviderType.Anthropic, {
            preparer: prepareAnthropicRequest,
            customSend: async (apiKey, req, onChunk, abortController) => {
                const anthropicReq = prepareAnthropicRequest(req);
                return sendAnthropicRequest(apiKey, anthropicReq, onChunk, abortController);
            },
        });

        // Google: native Gemini API for visible thinking/reasoning
        this.handlerCache.set(ProviderType.Google, {
            preparer: (_req) => { /* handled by customSend */ },
            customSend: async (apiKey, req, onChunk, abortController) => {
                if (req.stream) {
                    return sendGeminiStreamingRequest(apiKey, req, onChunk, abortController);
                }
                return sendGeminiNonStreamingRequest(apiKey, req, abortController);
            },
        });

        // DeepSeek: reasoning_content rehydration + placeholder injection
        this.handlerCache.set(ProviderType.DeepSeek, {
            preparer: prepareDeepSeekRequest,
            chunkTransformer: transformDeepSeekStreamChunk,
        });

        // MiniMax: <think> tag handling
        this.handlerCache.set(ProviderType.MiniMax, {
            preparer: prepareMiniMaxRequest,
            chunkTransformer: transformMiniMaxStreamChunk,
        });

        // Moonshot: reasoning_content native
        this.handlerCache.set(ProviderType.Moonshot, {
            preparer: prepareMoonshotRequest,
        });

        // Xiaomi: max_tokens→max_completion_tokens, thinking injection, reasoning_details→reasoning_content
        this.handlerCache.set(ProviderType.Xiaomi, {
            preparer: prepareXiaomiRequest,
        });

        // Zhipu: extra_body.thinking toggle
        this.handlerCache.set(ProviderType.Zhipu, {
            preparer: prepareZhipuRequest,
        });

        // OpenRouter: pure passthrough
        this.handlerCache.set(ProviderType.OpenRouter, {
            preparer: (_req) => { /* no-op */ },
        });

        // Mistral: OpenAI-compatible
        this.handlerCache.set(ProviderType.Mistral, {
            preparer: noopPreparer,
        });

        // DashScope (Qwen): OpenAI-compatible; enables Qwen thinking by default
        this.handlerCache.set(ProviderType.DashScope, {
            preparer: prepareDashScopeRequest,
        });

        // xAI (Grok): OpenAI-compatible
        this.handlerCache.set(ProviderType.XAI, {
            preparer: noopPreparer,
        });

        // Bedrock: not yet supported. It requires the AWS Converse API with
        // SigV4 signing, not the OpenAI-compatible Bearer-token path the default
        // send would use — that would POST to bedrock-runtime/chat/completions
        // and hard-fail with a misleading HTTP error. Fail fast with a clear
        // message instead until real Bedrock support exists.
        this.handlerCache.set(ProviderType.Bedrock, {
            preparer: prepareBedrockRequest,
            customSend: async () => {
                throw new Error(
                    'AWS Bedrock is not yet supported by LLM Local Router (it needs the ' +
                    'Converse API with SigV4 signing, not an OpenAI-compatible endpoint). ' +
                    'Use a custom provider pointing at an OpenAI-compatible Bedrock proxy instead.'
                );
            },
        });

        // Vertex AI (Gemini): Reuses Google Gemini native API
        this.handlerCache.set(ProviderType.Vertex, {
            preparer: prepareVertexRequest,
            customSend: async (apiKey, req, onChunk, abortController) => {
                if (req.stream) {
                    return sendGeminiStreamingRequest(apiKey, req, onChunk, abortController);
                }
                return sendGeminiNonStreamingRequest(apiKey, req, abortController);
            },
        });

        // Anthropic Vertex: Reuses Anthropic Messages API
        this.handlerCache.set(ProviderType.AnthropicVertex, {
            preparer: prepareAnthropicRequest,
            customSend: async (apiKey, req, onChunk, abortController) => {
                const anthropicReq = prepareAnthropicRequest(req);
                return sendAnthropicRequest(apiKey, anthropicReq, onChunk, abortController);
            },
        });

        // Ollama: OpenAI-compatible
        this.handlerCache.set(ProviderType.Ollama, {
            preparer: noopPreparer,
        });

        // LM Studio: OpenAI-compatible
        this.handlerCache.set(ProviderType.LmStudio, {
            preparer: noopPreparer,
        });

        // Fireworks: OpenAI-compatible
        this.handlerCache.set(ProviderType.Fireworks, {
            preparer: noopPreparer,
        });

        // SambaNova: OpenAI-compatible
        this.handlerCache.set(ProviderType.SambaNova, {
            preparer: noopPreparer,
        });

        // Baseten: OpenAI-compatible
        this.handlerCache.set(ProviderType.Baseten, {
            preparer: noopPreparer,
        });

        // Requesty: OpenAI-compatible router
        this.handlerCache.set(ProviderType.Requesty, {
            preparer: noopPreparer,
        });

        // Unbound: OpenAI-compatible router
        this.handlerCache.set(ProviderType.Unbound, {
            preparer: noopPreparer,
        });

        // Vercel AI Gateway: OpenAI-compatible proxying
        this.handlerCache.set(ProviderType.VercelAiGateway, {
            preparer: noopPreparer,
        });

        // Z.ai: OpenAI-compatible with thinking support
        this.handlerCache.set(ProviderType.ZAi, {
            preparer: prepareZAiRequest,
        });
    }

    updateApiKeys(keys: Record<string, string | undefined>): void {
        this.apiKeys = keys as ProviderApiKeys;
    }

    /** Update custom provider API keys (providerId → key). */
    updateCustomApiKeys(keys: Record<string, string>): void {
        this.customApiKeys = keys;
    }

    updateEndpointUrls(urls: Record<string, string>): void {
        this.endpointUrls = urls;
    }

    updateCompositeModels(models: Record<string, CompositeModelConfig>): void {
        this.compositeModels = models;
    }

    /**
     * Set the full list of user-registered custom providers and rebuild
     * the reverse model→provider index.
     */
    updateCustomProviders(providers: Map<string, CustomProviderConfig>): void {
        this.customProviders = providers;
        this.customModelIndex.clear();
        getLogger().info(`[customProvider:router] updateCustomProviders — ${providers.size} providers, ids: ${JSON.stringify([...providers.keys()])}`);
        for (const [providerId, cfg] of providers) {
            for (const model of cfg.models) {
                this.customModelIndex.set(model.id, providerId);
                getLogger().info(`[customProvider:router] model index: ${model.id} → ${providerId}`);
            }
        }
        getLogger().info(`[customProvider:router] model index size: ${this.customModelIndex.size}`);
    }

    /**
     * Look up a custom provider config by model ID.
     */
    getCustomProviderForModel(modelId: string): { providerId: string; config: CustomProviderConfig } | undefined {
        const providerId = this.customModelIndex.get(modelId);
        if (!providerId) return undefined;
        const config = this.customProviders.get(providerId);
        if (!config) return undefined;
        return { providerId, config };
    }

    /**
     * Get all custom provider models as a flat list with pricing info.
     */
    getCustomProviderModels(): Array<{ model: CustomProviderModel; providerId: string; providerLabel: string; pricing?: { prompt?: number; completion?: number; cacheRead?: number } }> {
        const result: Array<{ model: CustomProviderModel; providerId: string; providerLabel: string; pricing?: { prompt?: number; completion?: number; cacheRead?: number } }> = [];
        for (const [providerId, cfg] of this.customProviders) {
            for (const model of cfg.models) {
                result.push({
                    model,
                    providerId,
                    providerLabel: cfg.label,
                    pricing: cfg.defaultPricing,
                });
            }
        }
        return result;
    }

    /**
     * Get the API key for a provider. Falls back through common key names.
     */
    getApiKey(provider: ProviderType): string {
        const keys = this.apiKeys as Record<string, string | undefined>;
        return keys[provider] ?? '';
    }

    /**
     * Get the API key for a custom provider by ID.
     */
    getCustomApiKey(providerId: string): string {
        return this.customApiKeys[providerId] ?? '';
    }

    /**
     * Determine the resolved provider for a model ID.
     * Composite models (local/*) are handled by the composite layer, not here.
     * Custom providers are resolved first, then the built-in registry.
     */
    /**
     * Resolve the effective base URL for a provider, preferring custom over default.
     */
    private getBaseUrl(provider: ProviderType): string {
        return this.endpointUrls[provider] || PROVIDER_BASE_URLS[provider];
    }

    /**
     * Resolve routing info for a model ID. Returns both built-in and custom
     * provider routing information.
     */
    resolveProvider(modelId: string): {
        provider?: ProviderType;
        modelId: string;
        baseUrl: string;
        /** If set, this is a custom provider — use custom send path instead of handlerCache. */
        customProviderId?: string;
        customProtocol?: string;
    } | undefined {
        // Check if it's a composite model
        if (modelId.startsWith('local/') && this.compositeModels[modelId]) {
            // Return the first model's provider as a hint (composite layer overrides)
            const comp = this.compositeModels[modelId];
            const firstEntry = comp.models[0];
            const firstModelId = typeof firstEntry === 'string' ? firstEntry : firstEntry.id;

            // Check custom providers first
            const customForFirst = this.customModelIndex.get(firstModelId);
            if (customForFirst) {
                const customCfg = this.customProviders.get(customForFirst);
                if (customCfg) {
                    return {
                        modelId: firstModelId,
                        baseUrl: customCfg.endpointUrl,
                        customProviderId: customForFirst,
                        customProtocol: customCfg.protocol,
                    };
                }
            }

            const provider = getProviderForModel(firstModelId);
            if (provider) {
                return {
                    provider,
                    modelId: firstModelId,
                    baseUrl: this.getBaseUrl(provider),
                };
            }
            return undefined;
        }

        // Check custom providers first
        const customProviderId = this.customModelIndex.get(modelId);
        if (customProviderId) {
            const customCfg = this.customProviders.get(customProviderId);
            if (customCfg) {
                return {
                    modelId,
                    baseUrl: customCfg.endpointUrl,
                    customProviderId,
                    customProtocol: customCfg.protocol,
                };
            }
        }

        // Check built-in registry
        const provider = getProviderForModel(modelId);
        if (!provider) {
            // Unknown model — fall back to OpenRouter
            return {
                provider: ProviderType.OpenRouter,
                modelId,
                baseUrl: this.getBaseUrl(ProviderType.OpenRouter),
            };
        }

        return {
            provider,
            modelId,
            baseUrl: this.getBaseUrl(provider),
        };
    }

    /**
     * Build a ProviderHandler from a custom provider config based on its protocol.
     */
    private buildCustomHandler(protocol: string): ProviderHandler {
        switch (protocol) {
            case 'anthropic-compatible':
                return {
                    preparer: prepareAnthropicRequest,
                    customSend: async (apiKey, req, onChunk, abortController) => {
                        const anthropicReq = prepareAnthropicRequest(req);
                        return sendAnthropicRequest(apiKey, anthropicReq, onChunk, abortController);
                    },
                };
            case 'google-compatible':
                return {
                    preparer: (_req) => { /* handled by customSend */ },
                    customSend: async (apiKey, req, onChunk, abortController) => {
                        if (req.stream) {
                            return sendGeminiStreamingRequest(apiKey, req, onChunk, abortController);
                        }
                        return sendGeminiNonStreamingRequest(apiKey, req, abortController);
                    },
                };
            case 'openai-compatible':
            default:
                return {
                    preparer: (_req) => { /* pure passthrough */ },
                };
        }
    }

    /**
     * Send a non-streaming chat completion request through the appropriate provider.
     */
    async sendRequest(
        modelId: string,
        request: ChatCompletionRequest,
        abortController: AbortController,
    ): Promise<ChatCompletionResponse> {
        const resolved = this.resolveProvider(modelId);
        if (!resolved) {
            throw new Error(`Unknown model: ${modelId}`);
        }

        const prepared = deepCloneRequest(request);
        prepared.model = resolved.modelId;

        // Route through custom provider if applicable
        if (resolved.customProviderId) {
            const apiKey = this.getCustomApiKey(resolved.customProviderId);
            const handler = this.buildCustomHandler(resolved.customProtocol || 'openai-compatible');
            handler.preparer(prepared);

            if (handler.customSend) {
                return handler.customSend(apiKey, prepared, () => {}, abortController);
            }

            const response = await sendNonStreamingRequest(
                resolved.baseUrl,
                apiKey,
                prepared,
                abortController,
            );
            if (handler.chunkTransformer) {
                handler.chunkTransformer(response);
            }
            return response;
        }

        // Built-in provider path
        const handler = this.handlerCache.get(resolved.provider!)!;
        const apiKey = this.getApiKey(resolved.provider!);
        handler.preparer(prepared);

        if (handler.customSend) {
            return handler.customSend(apiKey, prepared, () => {}, abortController);
        }

        const response = await sendNonStreamingRequest(
            resolved.baseUrl,
            apiKey,
            prepared,
            abortController,
        );

        if (handler.chunkTransformer) {
            handler.chunkTransformer(response);
        }

        return response;
    }

    /**
     * Send a streaming chat completion request through the appropriate provider.
     */
    async sendStreamingRequest(
        modelId: string,
        request: ChatCompletionRequest,
        onChunk: (chunk: ChatCompletionResponse) => void,
        abortController: AbortController,
    ): Promise<ChatCompletionResponse> {
        const resolved = this.resolveProvider(modelId);
        if (!resolved) {
            throw new Error(`Unknown model: ${modelId}`);
        }

        const prepared = deepCloneRequest(request);
        prepared.model = resolved.modelId;

        // Route through custom provider if applicable
        if (resolved.customProviderId) {
            const apiKey = this.getCustomApiKey(resolved.customProviderId);
            const handler = this.buildCustomHandler(resolved.customProtocol || 'openai-compatible');
            handler.preparer(prepared);

            if (handler.customSend) {
                return handler.customSend(apiKey, prepared, onChunk, abortController);
            }

            const wrappedOnChunk = handler.chunkTransformer
                ? (chunk: ChatCompletionResponse) => {
                      handler.chunkTransformer!(chunk);
                      onChunk(chunk);
                  }
                : onChunk;

            return sendStreamingRequest(
                resolved.baseUrl,
                apiKey,
                prepared,
                wrappedOnChunk,
                abortController,
            );
        }

        // Built-in provider path
        const handler = this.handlerCache.get(resolved.provider!)!;
        const apiKey = this.getApiKey(resolved.provider!);
        handler.preparer(prepared);

        if (handler.customSend) {
            return handler.customSend(apiKey, prepared, onChunk, abortController);
        }

        const wrappedOnChunk = handler.chunkTransformer
            ? (chunk: ChatCompletionResponse) => {
                  handler.chunkTransformer!(chunk);
                  onChunk(chunk);
              }
            : onChunk;

        return sendStreamingRequest(
            resolved.baseUrl,
            apiKey,
            prepared,
            wrappedOnChunk,
            abortController,
        );
    }

    /**
     * Check if we have API keys for at least one provider (built-in or custom).
     */
    hasAnyApiKey(): boolean {
        const hasBuiltIn = Object.values(this.apiKeys).some(k => k && k.length > 0);
        const hasCustom = Object.values(this.customApiKeys).some(k => k && k.length > 0);
        return hasBuiltIn || hasCustom;
    }

    /**
     * Check if a specific provider (built-in or custom) has an API key configured.
     */
    hasApiKeyForProvider(provider: string): boolean {
        // Check built-in
        const builtInKey = (this.apiKeys as Record<string, string | undefined>)[provider];
        if (builtInKey && builtInKey.length > 0) return true;

        // Check custom
        const customKey = this.customApiKeys[provider];
        if (customKey && customKey.length > 0) return true;

        return false;
    }

    /**
     * Check whether a provider ID refers to a registered custom provider.
     *
     * Custom providers are user-registered, so their presence in the config is
     * the opt-in signal to expose them via the VS Code LM API — unlike built-in
     * providers, a custom provider may legitimately have no stored API key
     * (e.g. a local endpoint).
     */
    isCustomProvider(providerId: string): boolean {
        return this.customProviders.has(providerId);
    }

    /**
     * Count how many providers have API keys configured (built-in + custom).
     */
    getConfiguredProviderCount(): number {
        const builtIn = Object.values(this.apiKeys).filter(k => k && k.length > 0).length;
        const custom = Object.values(this.customApiKeys).filter(k => k && k.length > 0).length;
        return builtIn + custom;
    }
}

// ─── Helpers ────────────────────────────────────────────────────────

function deepCloneRequest(req: ChatCompletionRequest): ChatCompletionRequest {
    return JSON.parse(JSON.stringify(req));
}

/**
 * Anthropic Messages API custom send path.
 * Uses the Anthropic-specific protocol translation from the anthropic provider module.
 */
import { sendAnthropicStreamingRequest, sendAnthropicNonStreamingRequest } from './providers/anthropic';

async function sendAnthropicRequest(
    apiKey: string,
    req: ChatCompletionRequest,
    onChunk: (chunk: ChatCompletionResponse) => void,
    abortController: AbortController,
): Promise<ChatCompletionResponse> {
    if (req.stream) {
        return sendAnthropicStreamingRequest(apiKey, req, onChunk, abortController);
    }
    return sendAnthropicNonStreamingRequest(apiKey, req, abortController);
}
