/**
 * Google Gemini provider client.
 *
 * Google Gemini uses an OpenAI-compatible endpoint, so this is mostly
 * a passthrough. The only transformation is forwarding reasoning_effort
 * and thinking_config parameters.
 *
 */

import { ChatCompletionRequest } from '../types';

export function prepareGoogleRequest(req: ChatCompletionRequest): void {
    // Google expects reasoning_effort and thinking_config via extra_body
    if (req.reasoningEffort) {
        if (!req.extraBody) req.extraBody = {};
        req.extraBody.reasoning_effort = req.reasoningEffort;
    }
}

export function getGoogleBaseUrl(): string {
    return 'https://generativelanguage.googleapis.com/v1beta';
}
