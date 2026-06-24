/**
 * Alibaba DashScope (Qwen) provider client.
 *
 * Uses the OpenAI-compatible DashScope API. Qwen3 "hybrid" models expose a
 * thinking mode toggled via extra_body.enable_thinking. We enable it by default
 * for thinking-capable models (instruct/coder models stay non-thinking).
 * Callers can override by setting enable_thinking explicitly on extraBody.
 *
 * Note: DashScope requires streaming when thinking is enabled, which is always
 * the case for the router's chat path.
 */

import { ChatCompletionRequest } from '../types';

/**
 * Qwen models that support (and default to) thinking mode. Coder models
 * (qwen3-coder-*) are agentic instruct models and stay non-thinking.
 */
const THINKING_MODELS = new Set([
    'qwen3-max',
    'qwen3.6-plus',
    'qwen3.6-flash',
    'qwen3-vl-plus',
    'qwen3-vl-flash',
]);

export function prepareDashScopeRequest(req: ChatCompletionRequest): void {
    if (!THINKING_MODELS.has(req.model)) return;
    if (!req.extraBody) req.extraBody = {};
    // Enabled by default; respect an explicit caller override.
    if (req.extraBody.enable_thinking === undefined) {
        req.extraBody.enable_thinking = true;
    }
}
