/**
 * Requesty provider client.
 *
 * Requesty is an LLM router with OpenAI-compatible `/v1/chat/completions`
 * endpoint that proxies to multiple underlying providers.
 */

import { ChatCompletionRequest } from '../types';

export function prepareRequestyRequest(_req: ChatCompletionRequest): void {
    // No transformations needed — Requesty is OpenAI-compatible
}

export function getRequestyBaseUrl(): string {
    return 'https://api.requesty.ai/v1';
}
