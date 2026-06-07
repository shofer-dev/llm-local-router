/**
 * Fireworks AI provider client.
 *
 * Fireworks uses an OpenAI-compatible `/v1/chat/completions` endpoint.
 */

import { ChatCompletionRequest } from '../types';

export function prepareFireworksRequest(_req: ChatCompletionRequest): void {
    // No transformations needed — Fireworks is OpenAI-compatible
}

export function getFireworksBaseUrl(): string {
    return 'https://api.fireworks.ai/inference/v1';
}
