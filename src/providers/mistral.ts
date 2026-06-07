/**
 * Mistral provider client.
 *
 * Uses OpenAI-compatible `/v1/chat/completions` endpoint.
 * Mistral's API supports thinking/reasoning content natively.
 */

import { ChatCompletionRequest } from '../types';

export function prepareMistralRequest(_req: ChatCompletionRequest): void {
    // No transformations needed — Mistral is OpenAI-compatible
    // Thinking/reasoning content is handled natively by the API
}

export function getMistralBaseUrl(): string {
    return 'https://api.mistral.ai/v1';
}
