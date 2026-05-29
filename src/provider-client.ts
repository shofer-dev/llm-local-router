/**
 * Provider client factory and routing logic.
 *
 * Selects the correct provider based on model ID, applies provider-specific
 * request transformations, and routes to the correct API endpoint with the
 * correct API key.
 *
 * the per-provider service files.
 */

import * as vscode from 'vscode';
import {
    ProviderType,
    ProviderApiKeys,
    ProviderClient,
    ChatCompletionRequest,
    ChatCompletionResponse,
    CompositeModelConfig,
} from './types';
import { getModelById, getProviderForModel } from './model-registry';
import {
    sendNonStreamingRequest,
    sendStreamingRequest,
} from './llm-client';
import { getLogger } from './logger';
import {
    prepareAnthropicRequest,
    transformAnthropicResponse,
    getAnthropicBaseUrl,
} from './providers/anthropic';
import { prepareOpenAIRequest, getOpenAIBaseUrl } from './providers/openai';
import { prepareDeepSeekRequest, transformDeepSeekStreamChunk, getDeepSeekBaseUrl } from './providers/deepseek';
import { prepareMiniMaxRequest, transformMiniMaxStreamChunk, getMiniMaxBaseUrl } from './providers/minimax';
import { prepareMoonshotRequest, getMoonshotBaseUrl } from './providers/moonshot';
import { prepareXiaomiRequest, getXiaomiBaseUrl } from './providers/xiaomi';
import { prepareZhipuRequest, getZhipuBaseUrl } from './providers/zhipu';
import { prepareGoogleRequest, getGoogleBaseUrl } from './providers/google';
import { getOpenRouterBaseUrl } from './providers/openrouter';

// ─── Provider endpoint configuration ───────────────────────────────

const PROVIDER_BASE_URLS: Record<ProviderType, string> = {
    [ProviderType.OpenAI]: 'https://api.openai.com/v1',
    [ProviderType.Anthropic]: 'https://api.anthropic.com/v1',
    [ProviderType.Google]: 'https://generativelanguage.googleapis.com/v1beta',
    [ProviderType.DeepSeek]: 'https://api.deepseek.com/v1',
    [ProviderType.MiniMax]: 'https://api.minimax.io/v1',
    [ProviderType.Moonshot]: 'https://api.moonshot.cn/v1',
    [ProviderType.Xiaomi]: 'https://api.xiaomimimo.com/v1',
    [ProviderType.Zhipu]: 'https://open.bigmodel.cn/api/paas/v4',
    [ProviderType.OpenRouter]: 'https://openrouter.ai/api/v1',
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
    private endpointUrls: Record<string, string> = {};
    private compositeModels: Record<string, CompositeModelConfig> = {};
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

        // Google: OpenAI-compatible endpoint passthrough
        this.handlerCache.set(ProviderType.Google, {
            preparer: prepareGoogleRequest,
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
    }

    updateApiKeys(keys: Record<string, string | undefined>): void {
        this.apiKeys = keys as ProviderApiKeys;
    }

    updateEndpointUrls(urls: Record<string, string>): void {
        this.endpointUrls = urls;
    }

    updateCompositeModels(models: Record<string, CompositeModelConfig>): void {
        this.compositeModels = models;
    }

    /**
     * Get the API key for a provider. Falls back through common key names.
     */
    getApiKey(provider: ProviderType): string {
        const keys = this.apiKeys as Record<string, string | undefined>;
        return keys[provider] ?? '';
    }

    /**
     * Determine the resolved provider for a model ID.
     * Composite models (shofer/*) are handled by the composite layer, not here.
     */
    /**
     * Resolve the effective base URL for a provider, preferring custom over default.
     */
    private getBaseUrl(provider: ProviderType): string {
        return this.endpointUrls[provider] || PROVIDER_BASE_URLS[provider];
    }

    resolveProvider(modelId: string): { provider: ProviderType; modelId: string; baseUrl: string } | undefined {
        // Check if it's a composite model
        if (modelId.startsWith('shofer/') && this.compositeModels[modelId]) {
            // Return the first model's provider as a hint (composite layer overrides)
            const comp = this.compositeModels[modelId];
            const firstEntry = comp.models[0];
            const firstModelId = typeof firstEntry === 'string' ? firstEntry : firstEntry.id;
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

        const handler = this.handlerCache.get(resolved.provider)!;
        const apiKey = this.getApiKey(resolved.provider);

        // Clone and prepare request
        const prepared = deepCloneRequest(request);
        prepared.model = resolved.modelId;
        handler.preparer(prepared);

        if (handler.customSend) {
            // Custom path (e.g., Anthropic)
            return handler.customSend(apiKey, prepared, () => {}, abortController);
        }

        const response = await sendNonStreamingRequest(
            resolved.baseUrl,
            apiKey,
            prepared,
            abortController,
        );

        // Apply chunk transformer if present
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

        const handler = this.handlerCache.get(resolved.provider)!;
        const apiKey = this.getApiKey(resolved.provider);

        // Clone and prepare request
        const prepared = deepCloneRequest(request);
        prepared.model = resolved.modelId;
        handler.preparer(prepared);

        if (handler.customSend) {
            return handler.customSend(apiKey, prepared, onChunk, abortController);
        }

        // Wrap onChunk with transformer if present
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
     * Check if we have API keys for at least one provider.
     */
    hasAnyApiKey(): boolean {
        return Object.values(this.apiKeys).some(k => k && k.length > 0);
    }

    /**
     * Check if a specific provider has an API key configured.
     */
    hasApiKeyForProvider(provider: string): boolean {
        const key = (this.apiKeys as Record<string, string | undefined>)[provider];
        return !!key && key.length > 0;
    }

    /**
     * Count how many providers have API keys configured.
     */
    getConfiguredProviderCount(): number {
        return Object.values(this.apiKeys).filter(k => k && k.length > 0).length;
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
