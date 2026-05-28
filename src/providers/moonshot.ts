/**
 * Moonshot / Kimi provider client.
 *
 * Moonshot uses an OpenAI-compatible API with native reasoning_content support.
 * For multi-turn tool calls, Kimi requires reasoning_content on assistant
 * messages (similar to DeepSeek). Without the Redis reasoning cache, we
 * inject a placeholder "•" for missing reasoning_content.
 *
 * Ported from llm-router/internal/services/moonshot.go.
 */

import { ChatCompletionRequest, MessageRole } from '../types';

const REASONING_PLACEHOLDER = '\u2022';

export function prepareMoonshotRequest(req: ChatCompletionRequest): void {
    // For each assistant message without reasoning_content, inject placeholder
    for (const msg of req.messages) {
        if (msg.role !== MessageRole.Assistant) continue;
        if (!msg.reasoningContent || msg.reasoningContent.trim() === '') {
            msg.reasoningContent = REASONING_PLACEHOLDER;
        }
    }
}

export function getMoonshotBaseUrl(): string {
    return 'https://api.moonshot.cn/v1';
}
