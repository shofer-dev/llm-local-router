/**
 * MiniMax provider client.
 *
 * MiniMax uses an OpenAI-compatible API with a non-standard reasoning format:
 * - reasoning_details: array of {type, id, format, index, text} objects
 *   instead of the standard reasoning_content string.
 * - reasoning_split: true must be set to get interleaved thinking.
 * - extra_body fields are expanded to top-level by MiniMax (not nested).
 *
 * This module handles the bidirectional conversion:
 *   Request:  reasoning_content → reasoning_details (what MiniMax expects)
 *   Response: reasoning_details → reasoning_content (standard format)
 *
 * Ported from llm-router/internal/services/minimax.go.
 */

import { ChatCompletionRequest, ChatCompletionResponse, MessageRole } from '../types';
import { getLogger } from '../logger';

/**
 * Prepare a MiniMax request:
 * 1. Set reasoning_split=true (expanded to top-level by MiniMax's marshaler)
 * 2. Convert reasoning_content → reasoning_details on assistant messages
 */
export function prepareMiniMaxRequest(req: ChatCompletionRequest): void {
    // MiniMax expects reasoning_split at the top level of the request JSON,
    // but we set it in extra_body and the marshaler (buildRequestBody) will
    // include it as extraBody. MiniMax actually expands extra_body to top level
    // via MarshalMiniMaxRequest. Since we talk directly to MiniMax's API
    // (OpenAI-compatible), we embed reasoning_split as a top-level field.
    if (!req.extraBody) req.extraBody = {};
    req.extraBody.reasoning_split = true;

    // Convert reasoning_content → reasoning_details for assistant messages.
    // MiniMax expects reasoning_details (a list of objects), not reasoning_content.
    for (const msg of req.messages) {
        if (msg.role !== MessageRole.Assistant) continue;

        // If reasoning_details already preserved from previous response, keep it
        const details = (msg as any).reasoningDetails;
        if (details && (Array.isArray(details) ? details.length > 0 : true)) {
            msg.reasoningContent = undefined;
            continue;
        }

        // If reasoning_content exists, reconstruct reasoning_details
        if (msg.reasoningContent && msg.reasoningContent.trim() !== '') {
            const detail = {
                type: 'reasoning.text',
                id: 'reasoning-text-1',
                format: 'MiniMax-response-v1',
                index: 0,
                text: msg.reasoningContent,
            };
            (msg as any).reasoningDetails = [detail];
            msg.reasoningContent = undefined;
        }
    }
}

/**
 * Transform a MiniMax response: extract reasoning_details → reasoning_content.
 * Handles both streaming (delta-level) and non-streaming (message-level).
 */
export function transformMiniMaxResponse(response: ChatCompletionResponse): void {
    for (const choice of response.choices) {
        // Handle non-streaming: extract from message
        if (choice.message) {
            const details = (choice.message as any).reasoning_details;
            if (Array.isArray(details) && details.length > 0) {
                const texts: string[] = [];
                for (const d of details) {
                    if (d.text && typeof d.text === 'string') {
                        texts.push(d.text);
                    }
                }
                if (texts.length > 0) {
                    choice.message.reasoningContent = texts.join('\n');
                }
            }
        }

        // Handle streaming: extract from delta
        if (choice.delta) {
            const details = (choice.delta as any).reasoning_details;
            if (Array.isArray(details) && details.length > 0) {
                const texts: string[] = [];
                for (const d of details) {
                    if (d.text && typeof d.text === 'string') {
                        texts.push(d.text);
                    }
                }
                if (texts.length > 0) {
                    choice.delta.reasoningContent = (choice.delta.reasoningContent || '') + texts.join('\n');
                }
            }
        }
    }
}

/**
 * Transform streaming chunks from MiniMax:
 * - Extract reasoning_details from delta and set as reasoning_content
 */
export function transformMiniMaxStreamChunk(chunk: ChatCompletionResponse): void {
    transformMiniMaxResponse(chunk);
}

export function getMiniMaxBaseUrl(): string {
    return 'https://api.minimax.io/v1';
}
