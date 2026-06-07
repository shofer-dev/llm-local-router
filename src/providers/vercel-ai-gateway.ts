/**
 * Vercel AI Gateway provider client.
 *
 * Vercel AI Gateway uses an OpenAI-compatible `/v1/chat/completions` endpoint
 * that proxies to multiple underlying providers.
 */

import { ChatCompletionRequest } from '../types';

export function prepareVercelAiGatewayRequest(_req: ChatCompletionRequest): void {
    // No transformations needed — Vercel AI Gateway is OpenAI-compatible
}

export function getVercelAiGatewayBaseUrl(): string {
    return 'https://ai-gateway.vercel.sh/v1';
}
