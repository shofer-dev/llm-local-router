/**
 * Zhipu GLM provider client.
 *
 * Uses an OpenAI-compatible API. Thinking mode is controlled via
 * extra_body.thinking toggle, and reasoning_content is natively supported.
 *
 * Routed through the Z.ai international Coding Plan endpoint rather than
 * bigmodel.cn, so a Z.ai coding-plan key serves the bare glm-* models.
 */

import { ChatCompletionRequest } from '../types';

/**
 * GLM models that support thinking (all 4.x and 5.x models).
 */
const THINKING_MODELS = new Set([
    'glm-5.2', 'glm-5.1', 'glm-5', 'glm-4.7', 'glm-4.6', 'glm-4.5',
]);

export function prepareZhipuRequest(req: ChatCompletionRequest): void {
    // Enable thinking for models that support it
    if (THINKING_MODELS.has(req.model)) {
        if (!req.extraBody) req.extraBody = {};
        req.extraBody.thinking = { type: 'enabled' };
    }
}

export function getZhipuBaseUrl(): string {
    return 'https://api.z.ai/api/coding/paas/v4';
}
