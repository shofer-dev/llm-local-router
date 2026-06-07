/**
 * Baseten provider client.
 *
 * Baseten uses an OpenAI-compatible `/v1/chat/completions` endpoint.
 */

import { ChatCompletionRequest } from '../types';

export function prepareBasetenRequest(_req: ChatCompletionRequest): void {
    // No transformations needed — Baseten is OpenAI-compatible
}

export function getBasetenBaseUrl(): string {
    return 'https://inference.baseten.co/v1';
}
