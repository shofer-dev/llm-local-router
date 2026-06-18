/**
 * Z.ai provider client.
 *
 * Z.ai (Zhipu International) uses an OpenAI-compatible `/v1/chat/completions`
 * endpoint with extended thinking support for GLM models.
 */

import { ChatCompletionRequest, ChatCompletionResponse } from '../types';

export function prepareZAiRequest(req: ChatCompletionRequest): void {
    // Z.ai supports thinking mode for GLM models
    // The thinking parameter is sent via extraBody
    const isThinkingModel = req.model.startsWith('glm-4.7') || req.model.startsWith('glm-5');
    if (isThinkingModel) {
        if (!req.extraBody) req.extraBody = {};
        // Only set thinking if not already configured
        if (!req.extraBody.thinking) {
            req.extraBody.thinking = { type: 'enabled' };
        }
    }
}

export function getZAiBaseUrl(): string {
    return 'https://api.z.ai/api/coding/paas/v4';
}
