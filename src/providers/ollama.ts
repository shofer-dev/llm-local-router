/**
 * Ollama provider client.
 *
 * Ollama uses an OpenAI-compatible `/v1/chat/completions` endpoint
 * when configured with the OpenAI-compatible API flag.
 *
 * Default base URL: http://localhost:11434/v1
 */

import { ChatCompletionRequest } from '../types';

export function prepareOllamaRequest(_req: ChatCompletionRequest): void {
    // No transformations needed — Ollama is OpenAI-compatible
}

export function getOllamaBaseUrl(): string {
    return 'http://localhost:11434/v1';
}
