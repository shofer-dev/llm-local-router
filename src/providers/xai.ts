/**
 * xAI provider client.
 *
 * xAI (Grok) uses OpenAI-compatible `/v1/chat/completions` endpoint.
 * Also supports the Responses API for Grok-4 models via `/v1/responses`.
 */

import { ChatCompletionRequest } from '../types';

export function prepareXAIRequest(_req: ChatCompletionRequest): void {
    // No transformations needed — xAI is OpenAI-compatible
    // Uses standard `/v1/chat/completions` endpoint
}

export function getXAIBaseUrl(): string {
    return 'https://api.x.ai/v1';
}
