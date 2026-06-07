/**
 * SambaNova provider client.
 *
 * SambaNova uses an OpenAI-compatible `/v1/chat/completions` endpoint.
 */

import { ChatCompletionRequest } from '../types';

export function prepareSambaNovaRequest(_req: ChatCompletionRequest): void {
    // No transformations needed — SambaNova is OpenAI-compatible
}

export function getSambaNovaBaseUrl(): string {
    return 'https://api.sambanova.ai/v1';
}
