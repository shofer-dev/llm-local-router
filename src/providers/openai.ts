/**
 * OpenAI provider client.
 *
 * Transformations:
 * - o-series and GPT-5.x models: remap max_tokens → max_completion_tokens
 * - Forward reasoning_effort via the request body (native OpenAI parameter)
 *
 * Ported from llm-router/internal/services/openai.go.
 */

import { ChatCompletionRequest } from '../types';

/**
 * OpenAI models that require max_completion_tokens instead of max_tokens.
 * GPT-5.x (o-series compatible) uses max_completion_tokens in the API.
 */
const MAX_COMPLETION_TOKENS_MODELS = new Set([
    'gpt-5.5',
    'gpt-5.5-pro',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'openai/gpt-5.5',
    'openai/gpt-5.5-pro',
    'openai/gpt-5.4',
    'openai/gpt-5.4-mini',
    'openai/gpt-5.4-nano',
]);

/**
 * Prepare an OpenAI request by applying model-specific transformations.
 */
export function prepareOpenAIRequest(req: ChatCompletionRequest): void {
    // For GPT-5.x / o-series models, remap max_tokens to max_completion_tokens
    if (MAX_COMPLETION_TOKENS_MODELS.has(req.model) && req.maxTokens !== undefined) {
        if (!req.extraBody) {
            req.extraBody = {};
        }
        req.extraBody.max_completion_tokens = req.maxTokens;
        // Don't send both; remove the standard max_tokens from the top-level
        // (the llm-client buildRequestBody will forward extraBody keys)
    }

    // Forward reasoning_effort for o-series models
    if (req.reasoningEffort && !req.extraBody) {
        req.extraBody = {};
    }
    if (req.reasoningEffort && req.extraBody) {
        req.extraBody.reasoning_effort = req.reasoningEffort;
    }
}

export function getOpenAIBaseUrl(): string {
    return 'https://api.openai.com/v1';
}
