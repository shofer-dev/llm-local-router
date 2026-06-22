/**
 * Google Vertex AI provider (Gemini via Vertex).
 *
 * Vertex reuses the native Gemini API: the ProviderHandler.customSend path in
 * provider-client routes Vertex through sendGeminiStreamingRequest /
 * sendGeminiNonStreamingRequest, so this module only needs the (no-op) request
 * preparer that the handler registers.
 *
 * NOTE: Vertex auth requires GoogleAuth credentials (service account / ADC /
 * key file) rather than a plain API key; full Vertex auth is not yet wired.
 */

import { ChatCompletionRequest } from '../types';

export function prepareVertexRequest(_req: ChatCompletionRequest): void {
    // No-op — the native Gemini API path handles conversion in customSend.
}
