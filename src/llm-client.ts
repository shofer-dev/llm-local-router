/**
 * HTTP client with SSE streaming support for LLM provider APIs.
 *
 * Handles direct HTTP communication with provider APIs, including:
 * - SSE streaming parse (data: {...}\n\n format)
 * - Non-streaming JSON responses
 * - Cost computation from registry pricing × usage
 * - Abort controller support for cancellation
 */

import {
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatDelta,
    ChatChoice,
    ChatMessage,
    MessageRole,
    ModelPricingPerMillion,
    ModelRegistryEntry,
    ProviderModelInfo,
    ProviderType,
    ToolCall,
    UsageInfo,
} from './types';
import { getModelById, ALL_MODELS } from './model-registry';
import { getLogger } from './logger';
import type { ModelPricing } from './types';

// ─── Per-model pricing overrides (runtime cost engine) ───────────────

/**
 * Module-level mutable map of per-model pricing overrides loaded from
 * SecretStorage. Keys are model IDs (e.g. "gpt-5.5"), values are partial
 * ModelPricing entries in USD per 1K tokens.
 *
 * Populated by {@link setModelPricingOverrides} at SecretStorage load time
 * and after every Config panel save.
 */
const modelPricingOverrides = new Map<string, ModelPricing>();

/**
 * Overwrite the in-memory per-model pricing overrides from a batch load.
 * Called after SecretStorage is read at startup and after Config panel save.
 * Keys are model IDs; values are pricing entries in the same per-1K-token
 * format as ModelPricing.
 */
export function setModelPricingOverrides(overrides: Record<string, ModelPricing>): void {
    modelPricingOverrides.clear();
    for (const [modelId, pricing] of Object.entries(overrides)) {
        if (pricing && (pricing.prompt || pricing.completion || pricing.contextCacheRead || pricing.contextCacheWrite)) {
            modelPricingOverrides.set(modelId, pricing);
        }
    }
}

/** Clear all per-model pricing overrides. */
export function clearModelPricingOverrides(): void {
    modelPricingOverrides.clear();
}

/**
 * Resolve the effective pricing for a model: per-model override wins,
 * otherwise fall back to the static ALL_MODELS registry entry.
 */
export function getEffectivePricing(modelId: string): ModelPricing | undefined {
    const override = modelPricingOverrides.get(modelId);
    if (override) return override;
    return getModelById(modelId)?.pricing;
}

export class LLMClientError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LLMClientError';
    }
}

/**
 * Compute USD cost for a response from registry pricing and token usage.
 */
export function computeCost(
    modelId: string,
    promptTokens: number,
    completionTokens: number,
    cachedTokens?: number,
    cacheCreationTokens?: number,
): number {
    const p = getEffectivePricing(modelId);
    if (!p) return 0;

    // Compute input cost: cached tokens at cache-read rate, remaining at prompt rate
    const effectiveCached = cachedTokens ?? 0;
    const uncachedPrompt = Math.max(0, promptTokens - effectiveCached);
    let cost = 0;
    cost += (uncachedPrompt / 1000) * (p.prompt ?? 0);
    if (effectiveCached > 0 && p.contextCacheRead) {
        cost += (effectiveCached / 1000) * p.contextCacheRead;
    }
    // Cache write cost
    if (cacheCreationTokens && cacheCreationTokens > 0 && p.contextCacheWrite) {
        cost += (cacheCreationTokens / 1000) * p.contextCacheWrite;
    }
    // Completion cost
    cost += (completionTokens / 1000) * (p.completion ?? 0);

    // Apply batch discount if present
    if (p.discount && p.discount > 0) {
        cost *= (1 - p.discount);
    }

    return Math.max(0, cost);
}

/**
 * Convert registry pricing (per-1K-token) to per-1M-token form
 * for VS Code LM API compatibility.
 */
export function toPerMillionPricing(modelId: string): ModelPricingPerMillion | undefined {
    const p = getEffectivePricing(modelId);
    if (!p) return undefined;
    // Per-1K → per-1M. Round to 6dp: the bare multiply yields binary-fraction
    // artifacts (0.00014 * 1000 === 0.13999999999999999, 0.00341 * 1000 ===
    // 3.4099999999999997) which surface raw in the Status table and to every
    // consumer of the getModelPricing side-channel. 6dp is far finer than any real
    // per-1M price, so this is lossless in practice — and cost is computed from the
    // per-1K values in computeCost(), never from these, so accounting is unaffected.
    const toPerM = (v: number | undefined): number | undefined =>
        v !== undefined && v > 0 ? Math.round(v * 1000 * 1e6) / 1e6 : undefined;

    const inputPrice = toPerM(p.prompt ?? 0);
    const outputPrice = toPerM(p.completion ?? 0);
    const cacheReadsPrice = toPerM(p.contextCacheRead);
    const cacheWritesPrice = toPerM(p.contextCacheWrite);

    if (inputPrice === undefined && outputPrice === undefined) return undefined;

    return {
        inputPrice: inputPrice ?? 0,
        outputPrice: outputPrice ?? 0,
        ...(cacheReadsPrice !== undefined && { cacheReadsPrice }),
        ...(cacheWritesPrice !== undefined && { cacheWritesPrice }),
    };
}

/**
 * Build the list of ProviderModelInfo entries for the VS Code LM API.
 */
export function getProviderModelInfoList(): ProviderModelInfo[] {
    return ALL_MODELS.map(m => ({
        id: m.id,
        name: m.name,
        family: m.id.replace(/\//g, '_'),
        version: '1.0',
        maxInputTokens: m.contextLength,
        maxOutputTokens: m.maxOutputTokens,
        capabilities: {
            imageInput: m.imageInput,
            toolCalling: m.toolCalling,
            promptCache: !!(m.pricing.contextCacheRead && m.pricing.contextCacheRead > 0),
            ...resolveModelToolPrefs(m),
        },
        pricing: toPerMillionPricing(m.id),
    }));
}

/**
 * Resolve a model's native-tool preferences for the capabilities side-channel:
 * explicit per-entry values win, otherwise provider-family defaults apply. Kept
 * in sync with llm-router's resolveModelToolPrefs so both router paths agree on
 * the same integrator-owned defaults. Returns only set keys so the spread leaves
 * capabilities untouched when there are no preferences.
 */
function resolveModelToolPrefs(m: ModelRegistryEntry): { includedTools?: string[]; excludedTools?: string[] } {
    if (m.includedTools?.length || m.excludedTools?.length) {
        return { includedTools: m.includedTools, excludedTools: m.excludedTools };
    }
    if (m.provider === ProviderType.OpenAI) {
        // OpenAI models perform better with apply_patch than apply_diff/write_to_file.
        return { includedTools: ['apply_patch'], excludedTools: ['apply_diff', 'write_to_file'] };
    }
    return {};
}

/**
 * Send a non-streaming chat completion request to a provider's API endpoint.
 */
export async function sendNonStreamingRequest(
    baseUrl: string,
    apiKey: string,
    request: ChatCompletionRequest,
    abortController: AbortController,
): Promise<ChatCompletionResponse> {
    const url = `${baseUrl}/chat/completions`;
    const body = buildRequestBody(request);

    const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(apiKey, url),
        body: JSON.stringify(body),
        signal: abortController.signal,
    });

    if (!response.ok) {
        const errorText = (await response.text()).slice(0, 1000);
        throw new LLMClientError(`HTTP ${response.status}: ${errorText}`);
    }

    const json = await response.json();
    return parseChatResponse(json, request.model);
}

/**
 * Send a streaming chat completion request, calling onChunk for each SSE delta.
 */
export async function sendStreamingRequest(
    baseUrl: string,
    apiKey: string,
    request: ChatCompletionRequest,
    onChunk: (chunk: ChatCompletionResponse) => void,
    abortController: AbortController,
): Promise<ChatCompletionResponse> {
    const url = `${baseUrl}/chat/completions`;
    const body = buildRequestBody(request);
    body.stream = true;

    const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(apiKey, url),
        body: JSON.stringify(body),
        signal: abortController.signal,
    });

    if (!response.ok) {
        const errorText = (await response.text()).slice(0, 1000);
        throw new LLMClientError(`HTTP ${response.status}: ${errorText}`);
    }

    return parseStreamingResponse(response, request.model, onChunk);
}

/**
 * Extract reasoning text from MiniMax reasoning_details format.
 * reasoning_details is an array of {type, id, format, index, text} objects.
 * Returns a joined string or undefined if no text found.
 */
function extractReasoningFromDetails(details: unknown): string | undefined {
    if (!Array.isArray(details) || details.length === 0) return undefined;
    const texts: string[] = [];
    for (const d of details) {
        if (d && typeof d.text === 'string' && d.text.trim()) {
            texts.push(d.text);
        }
    }
    return texts.length > 0 ? texts.join('\n') : undefined;
}

// ─── Internal helpers ───────────────────────────────────────────────

/**
 * Roo Code client-identity headers. Z.ai's GLM Coding Plan attributes
 * usage to supported coding tools by these headers, so requests to
 * api.z.ai mimic Roo Code. Verified working via the OpenAI-compatible
 * coding endpoint (https://api.z.ai/api/coding/paas/v4).
 */
const ROO_CODE_HEADERS: Record<string, string> = {
    'HTTP-Referer': 'https://github.com/RooVetGit/Roo-Cline',
    'X-Title': 'Roo Code',
    'User-Agent': 'RooCode/3.53.0',
};

function buildHeaders(apiKey: string, url?: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(url && url.includes('api.z.ai') ? ROO_CODE_HEADERS : {}),
    };
}

/** Router-internal fields that must NOT be forwarded to upstream providers. */
const INTERNAL_FIELDS = ['task_id', 'parent_task_id', 'root_task_id'];

function buildRequestBody(request: ChatCompletionRequest): Record<string, unknown> {
    const messages = request.messages.map(msg => {
        const m: Record<string, unknown> = { role: msg.role, content: msg.content };
        if (msg.reasoningContent) m.reasoning_content = msg.reasoningContent;
        if (msg.toolCallId) m.tool_call_id = msg.toolCallId;
        if (msg.toolCalls && msg.toolCalls.length > 0) {
            m.tool_calls = msg.toolCalls.map(tc => ({
                id: tc.id,
                type: tc.type,
                function: { name: tc.function.name, arguments: tc.function.arguments },
            }));
        }
        // Forward provider-specific message fields (e.g. MiniMax reasoning_details)
        const msgAny = msg as unknown as Record<string, unknown>;
        if (msgAny.reasoningDetails) {
            m.reasoning_details = msgAny.reasoningDetails;
        }
        return m;
    });

    const body: Record<string, unknown> = {
        model: request.model,
        messages,
        temperature: request.temperature ?? 0.7,
    };

    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.tools && request.tools.length > 0) {
        body.tools = request.tools.map(t => ({
            type: t.type,
            function: {
                name: t.function.name,
                description: t.function.description,
                parameters: t.function.parameters,
                ...(t.function.strict !== undefined && { strict: t.function.strict }),
            },
        }));
    }
    if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
    if (request.reasoningEffort) body.reasoning_effort = request.reasoningEffort;

    // Propagate extra_body (deep merged)
    if (request.extraBody) {
        for (const [k, v] of Object.entries(request.extraBody)) {
            if (!INTERNAL_FIELDS.includes(k)) {
                body[k] = v;
            }
        }
    }

    return body;
}

function parseChatResponse(obj: Record<string, unknown>, requestModel: string): ChatCompletionResponse {
    const choices: ChatChoice[] = ((obj.choices as any[]) || []).map((choice: any) => {
        // Parse tool_calls from message
        const messageToolCalls: ToolCall[] | undefined = choice.message?.tool_calls?.map((tc: any) => ({
            id: tc.id ?? '',
            type: tc.type ?? 'function',
            function: {
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments ?? '',
            },
        }));

        // Parse tool_calls from delta (streaming)
        const deltaToolCalls: Partial<ToolCall>[] | undefined = choice.delta?.tool_calls?.map((tc: any) => ({
            id: tc.id,
            type: tc.type,
            index: tc.index,
            function: tc.function ? { name: tc.function.name, arguments: tc.function.arguments } : undefined,
        }));

        // Extract reasoning_content: prefer the standard field, but also check
        // MiniMax's reasoning_details format (array of {text} objects).
        const msgReasoning = choice.message?.reasoning_content
            || extractReasoningFromDetails(choice.message?.reasoning_details)
            || undefined;
        const deltaReasoning = choice.delta?.reasoning_content
            || extractReasoningFromDetails(choice.delta?.reasoning_details)
            || undefined;

        return {
            index: choice.index ?? 0,
            message: choice.message ? {
                role: stringToRole(choice.message.role),
                content: choice.message.content ?? '',
                toolCalls: messageToolCalls,
                reasoningContent: msgReasoning,
            } : undefined,
            delta: choice.delta ? {
                role: choice.delta.role ? stringToRole(choice.delta.role) : undefined,
                content: choice.delta.content ?? '',
                toolCalls: deltaToolCalls,
                reasoningContent: deltaReasoning,
            } : undefined,
            finishReason: choice.finish_reason,
        };
    });

    const usage: UsageInfo | undefined = obj.usage ? {
        promptTokens: (obj.usage as any).prompt_tokens ?? 0,
        completionTokens: (obj.usage as any).completion_tokens ?? 0,
        totalTokens: (obj.usage as any).total_tokens ?? 0,
        cachedTokens: (obj.usage as any).prompt_tokens_details?.cached_tokens
            ?? (obj.usage as any).prompt_cache_hit_tokens,
        cacheCreationTokens: (obj.usage as any).prompt_tokens_details?.cache_creation_tokens
            ?? (obj.usage as any).cache_creation_input_tokens,
        costUsd: computeCost(
            requestModel,
            (obj.usage as any).prompt_tokens ?? 0,
            (obj.usage as any).completion_tokens ?? 0,
            (obj.usage as any).prompt_tokens_details?.cached_tokens ?? (obj.usage as any).prompt_cache_hit_tokens,
            (obj.usage as any).prompt_tokens_details?.cache_creation_tokens ?? (obj.usage as any).cache_creation_input_tokens,
        ),
    } : undefined;

    return {
        id: (obj.id as string) ?? '',
        object: (obj.object as string) ?? '',
        created: (obj.created as number) ?? 0,
        model: (obj.model as string) ?? '',
        choices,
        usage,
    };
}

/**
 * Read a Server-Sent Events response, invoking `onData` with each `data:`
 * payload (the text after the `data:` prefix). Shared by all provider stream
 * parsers so the read-loop/decode/line-split/buffer handling lives in one place.
 *
 * Handles: chunk-boundary line splitting, `\r\n` terminators (via trim),
 * `data:` with or without a trailing space, `:`-comment/keepalive lines and
 * non-`data:` fields (e.g. Anthropic's `event:` lines), and flushing the final
 * line at end-of-stream. `onData` exceptions propagate (after the reader lock is
 * released) so callers can abort on a fatal error.
 */
export async function readSSE(
    response: globalThis.Response,
    onData: (data: string) => void,
): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) throw new LLMClientError('Response body is not readable');

    const decoder = new TextDecoder();
    let buffer = '';

    const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) return; // blank or comment/keepalive
        if (!trimmed.startsWith('data:')) return;         // ignore event:/id: fields
        onData(trimmed.slice(5).trimStart());
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) handleLine(line);
        }
        // Flush any final line not terminated by a newline.
        if (buffer) handleLine(buffer);
    } finally {
        reader.releaseLock();
    }
}

async function parseStreamingResponse(
    response: globalThis.Response,
    requestModel: string,
    onChunk?: (chunk: ChatCompletionResponse) => void,
): Promise<ChatCompletionResponse> {
    let aggregated: ChatCompletionResponse | null = null;

    await readSSE(response, (data) => {
        if (data === '[DONE]') return;

        try {
            const obj = JSON.parse(data);

            // Check for error in SSE chunk
            if (obj.error) {
                throw new LLMClientError(obj.error.message || 'Unknown streaming error');
            }

            const chunk = parseChatResponse(obj, requestModel);

            if (onChunk) onChunk(chunk);

            if (!aggregated) {
                aggregated = { ...chunk };
            } else {
                // Merge choices
                for (const choice of chunk.choices) {
                    const existing = aggregated.choices.find(c => c.index === choice.index);
                    if (existing) {
                        if (choice.delta?.content) {
                            existing.delta = existing.delta || {};
                            existing.delta.content = (existing.delta.content || '') + choice.delta.content;
                        }
                        if (choice.delta?.reasoningContent) {
                            existing.delta = existing.delta || {};
                            existing.delta.reasoningContent = (existing.delta.reasoningContent || '') + choice.delta.reasoningContent;
                        }
                        if (choice.delta?.toolCalls && choice.delta.toolCalls.length > 0) {
                            existing.delta = existing.delta || {};
                            existing.delta.toolCalls = existing.delta.toolCalls || [];
                            for (const tc of choice.delta.toolCalls) {
                                const tcIndex = tc.index ?? 0;
                                const existingTc = existing.delta.toolCalls.find(
                                    (t, i) => (t.index !== undefined ? t.index === tcIndex : i === tcIndex)
                                );
                                if (existingTc) {
                                    if (tc.function?.arguments) {
                                        existingTc.function = existingTc.function || { name: '', arguments: '' };
                                        existingTc.function.arguments = (existingTc.function.arguments || '') + tc.function.arguments;
                                    }
                                    if (tc.function?.name) {
                                        existingTc.function = existingTc.function || { name: '', arguments: '' };
                                        existingTc.function.name = tc.function.name;
                                    }
                                } else {
                                    existing.delta.toolCalls.push({
                                        id: tc.id,
                                        type: tc.type,
                                        index: tcIndex,
                                        function: tc.function ? {
                                            name: tc.function.name || '',
                                            arguments: tc.function.arguments || '',
                                        } : undefined,
                                    });
                                }
                            }
                        }
                        if (choice.finishReason) {
                            existing.finishReason = choice.finishReason;
                        }
                    } else {
                        aggregated.choices.push({ ...choice });
                    }
                }
                if (chunk.usage) {
                    aggregated.usage = chunk.usage;
                }
            }
        } catch (parseError) {
            if (parseError instanceof LLMClientError) throw parseError;
            getLogger().warning(`Failed to parse SSE chunk: ${parseError}`);
        }
    });

    if (!aggregated) {
        throw new LLMClientError('No valid chunks received from streaming response');
    }

    return aggregated;
}

function stringToRole(roleStr: string): MessageRole {
    switch (roleStr) {
        case 'system': return MessageRole.System;
        case 'user': return MessageRole.User;
        case 'assistant': return MessageRole.Assistant;
        case 'tool': return MessageRole.Tool;
        default: return MessageRole.User;
    }
}
