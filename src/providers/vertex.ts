/**
 * Google Vertex AI provider (Gemini via Vertex).
 *
 * Uses the same native Gemini API as the Google provider but with
 * Vertex AI authentication (OAuth2 / service account instead of API key).
 *
 * The endpoint differs from standard Google AI:
 *   https://{LOCATION}-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{LOCATION}/publishers/google/models/{MODEL}:generateContent
 *
 * Vertex auth requires GoogleAuth credentials (service account JSON,
 * application default credentials, or key file).
 */

import { ChatCompletionRequest, ChatCompletionResponse } from '../types';
import { LLMClientError } from '../llm-client';

/**
 * Send a non-streaming request via Vertex AI Gemini endpoint.
 * This is a stub that delegates to the same OpenAI-compatible endpoint as Google.
 * Users should configure Vertex auth through the endpoint URL with proper GoogleAuth.
 */
export async function sendVertexNonStreamingRequest(
    apiKey: string,
    request: ChatCompletionRequest,
    abortController: AbortController,
): Promise<ChatCompletionResponse> {
    // Vertex uses GoogleAuth Bearer tokens, not API keys.
    // The apiKey here should actually be a Bearer token obtained via GoogleAuth.
    const baseUrl = request.extraBody?.vertexEndpoint as string
        || 'https://us-central1-aiplatform.googleapis.com/v1/projects';

    const modelId = request.model;
    const projectId = (request.extraBody as any)?.vertexProjectId || 'default';
    const location = (request.extraBody as any)?.vertexRegion || 'us-central1';
    const url = `${baseUrl}/${projectId}/locations/${location}/publishers/google/models/${modelId}:generateContent`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(request),
        signal: abortController.signal,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new LLMClientError(`Vertex HTTP ${response.status}: ${errorText}`);
    }

    return response.json();
}

export function prepareVertexRequest(_req: ChatCompletionRequest): void {
    // Vertex uses the same native Gemini API — prepareGeminiRequest handles the conversion.
    // The custom send path in provider-client routes to sendVertexStreamingRequest/sendVertexNonStreamingRequest.
}

export function getVertexBaseUrl(): string {
    return 'https://us-central1-aiplatform.googleapis.com/v1';
}
