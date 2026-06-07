/**
 * LM Studio provider client.
 *
 * LM Studio exposes an OpenAI-compatible `/v1/chat/completions` endpoint.
 *
 * Default base URL: http://localhost:1234/v1
 */

import { ChatCompletionRequest } from '../types';

export function prepareLmStudioRequest(_req: ChatCompletionRequest): void {
    // No transformations needed — LM Studio is OpenAI-compatible
}

export function getLmStudioBaseUrl(): string {
    return 'http://localhost:1234/v1';
}
