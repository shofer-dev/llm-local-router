/**
 * OpenRouter provider client.
 *
 * Pure passthrough — OpenRouter is the catch-all for unknown models
 * and uses the standard OpenAI-compatible API.
 */

import { ChatCompletionRequest } from '../types';

export function prepareOpenRouterRequest(_req: ChatCompletionRequest): void {
    // No transformations needed — OpenRouter is OpenAI-compatible
}

export function getOpenRouterBaseUrl(): string {
    return 'https://openrouter.ai/api/v1';
}
