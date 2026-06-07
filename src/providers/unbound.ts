/**
 * Unbound provider client.
 *
 * Unbound is an LLM router with OpenAI-compatible `/v1/chat/completions`
 * endpoint that proxies to multiple underlying providers.
 */

import { ChatCompletionRequest } from '../types';

export function prepareUnboundRequest(_req: ChatCompletionRequest): void {
    // No transformations needed — Unbound is OpenAI-compatible
}

export function getUnboundBaseUrl(): string {
    return 'https://api.getunbound.ai/v1';
}
