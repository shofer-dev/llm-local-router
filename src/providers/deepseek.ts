/**
 * DeepSeek provider client.
 *
 * DeepSeek uses an OpenAI-compatible API with extensions for thinking mode:
 * - reasoning_content must be echoed back on every assistant message in
 *   the conversation history or the API returns 400.
 * - Without Redis, we inject a placeholder "•" character for missing
 *   reasoning_content to satisfy the round-trip requirement.
 * - prompt_cache_hit_tokens is mapped to the canonical cached_tokens slot.
 *
 * Ported from llm-router/internal/services/deepseek.go.
 */

import { ChatCompletionRequest, ChatCompletionResponse, MessageRole } from '../types';
import { getLogger } from '../logger';

/**
 * Placeholder used when reasoning_content is missing from an assistant
 * message in the history. DeepSeek requires non-empty reasoning_content
 * on every assistant message when thinking mode is enabled.
 */
const REASONING_PLACEHOLDER = '\u2022'; // bullet character

export function prepareDeepSeekRequest(req: ChatCompletionRequest): void {
    const logger = getLogger();

    // For each assistant message without reasoning_content, inject placeholder.
    // Also propagate reasoning_effort via extra_body.
    for (const msg of req.messages) {
        if (msg.role !== MessageRole.Assistant) continue;

        // If reasoning_content is missing, inject placeholder
        if (!msg.reasoningContent || msg.reasoningContent.trim() === '') {
            msg.reasoningContent = REASONING_PLACEHOLDER;
        }
    }

    // Forward reasoning_effort for DeepSeek thinking control
    if (req.reasoningEffort) {
        if (!req.extraBody) req.extraBody = {};
        req.extraBody.reasoning_effort = req.reasoningEffort;
    }
}

/**
 * Transform streaming chunks from DeepSeek:
 * - Map prompt_cache_hit_tokens → cached_tokens in usage
 */
export function transformDeepSeekStreamChunk(chunk: ChatCompletionResponse): void {
    if (chunk.usage) {
        // DeepSeek uses prompt_cache_hit_tokens; normalize to cached_tokens
        const usageAny = chunk.usage as any;
        if (usageAny.prompt_cache_hit_tokens !== undefined && chunk.usage.cachedTokens === undefined) {
            chunk.usage.cachedTokens = usageAny.prompt_cache_hit_tokens;
        }
    }
}

export function getDeepSeekBaseUrl(): string {
    return 'https://api.deepseek.com/v1';
}
