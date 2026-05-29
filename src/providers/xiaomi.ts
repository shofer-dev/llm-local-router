/**
 * Xiaomi MiMo provider client.
 *
 * Transformations:
 * - max_tokens → max_completion_tokens (MiMo uses max_completion_tokens)
 * - Removes stream_options (not supported by MiMo)
 * - Injects thinking parameter based on model type
 * - reasoning_details → reasoning_content conversion for multi-turn
 *   (RooCode stores accumulated reasoning as reasoning_details)
 *
 */

import { ChatCompletionRequest, MessageRole } from '../types';
import { getLogger } from '../logger';

/**
 * MiMo models that have thinking enabled by default.
 */
const THINKING_MODELS = new Set([
    'mimo-v2-pro',
    'mimo-v2-omni',
]);

/**
 * MiMo models that have thinking disabled by default.
 */
const NO_THINKING_MODELS = new Set([
    'mimo-v2-tts',
    'mimo-v2-flash',
]);

export function prepareXiaomiRequest(req: ChatCompletionRequest): void {
    const logger = getLogger();

    // Remove stream_options — not supported by MiMo
    if (req.extraBody?.stream_options) {
        delete req.extraBody.stream_options;
    }

    // Inject thinking parameter based on model type
    const modelLower = req.model.toLowerCase();
    let thinkingEnabled = false;

    if (THINKING_MODELS.has(req.model) || modelLower.includes('mimo-v2-pro') || modelLower.includes('mimo-v2-omni')) {
        thinkingEnabled = true;
    } else if (NO_THINKING_MODELS.has(req.model) || modelLower.includes('mimo-v2-tts') || modelLower.includes('mimo-v2-flash')) {
        thinkingEnabled = false;
    } else {
        // Default to enabled for unknown MiMo models
        thinkingEnabled = true;
    }

    if (thinkingEnabled) {
        if (!req.extraBody) req.extraBody = {};
        req.extraBody.thinking = { type: 'enabled' };
    }

    // Remap max_tokens to max_completion_tokens (MiMo convention)
    if (req.maxTokens !== undefined) {
        if (!req.extraBody) req.extraBody = {};
        req.extraBody.max_completion_tokens = req.maxTokens;
    }

    // Convert reasoning_details → reasoning_content for multi-turn tool calls.
    // RooCode stores accumulated reasoning as reasoning_details (format "roo-code-v1").
    for (const msg of req.messages) {
        if (msg.role !== MessageRole.Assistant) continue;

        // If reasoning_content is already set, clear reasoning_details to avoid duplication
        if (msg.reasoningContent && msg.reasoningContent.trim() !== '') {
            (msg as any).reasoningDetails = undefined;
            continue;
        }

        const details = (msg as any).reasoningDetails;
        if (!details) continue;

        let detailsArr: any[];
        try {
            detailsArr = typeof details === 'string' ? JSON.parse(details) : details;
            if (!Array.isArray(detailsArr)) continue;
        } catch {
            logger.warning(`[XIAOMI] Failed to parse reasoning_details`);
            continue;
        }

        const texts: string[] = [];
        for (const detail of detailsArr) {
            if (typeof detail.text === 'string' && detail.text) {
                texts.push(detail.text);
            }
        }

        if (texts.length > 0) {
            msg.reasoningContent = texts.join('\n');
            (msg as any).reasoningDetails = undefined;
        }
    }
}

export function getXiaomiBaseUrl(): string {
    return 'https://api.xiaomimimo.com/v1';
}
