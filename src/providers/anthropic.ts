/**
 * Anthropic provider client.
 *
 * Full OpenAI Chat Completions ↔ Anthropic Messages API protocol translation.
 * This is the most complex provider adapter because Anthropic's wire format
 * is fundamentally different from the OpenAI-compatible format used by all
 * other providers.
 *
 * Request (OpenAI → Anthropic):
 *   - System prompt extraction: top-level `system` field instead of `system`-role message
 *   - Content normalization: string content unwrapped for text; arrays passed through
 *   - Tool definitions: OpenAI `tools` → Anthropic `tools` format
 *   - Stop sequences: OpenAI `stop` → `stop_sequences` array
 *   - Max_tokens: required by Anthropic; defaults to 4096 if absent
 *
 * Response (Anthropic → OpenAI):
 *   - Content blocks → choices[0].message.content (text blocks)
 *   - Tool use blocks → choices[0].message.tool_calls
 *   - Stop reason → finish_reason mapping
 *   - Usage: input_tokens/output_tokens → prompt_tokens/completion_tokens
 *   - Cache tokens: cache_read_input_tokens → PromptTokensDetails.CachedTokens
 *
 * Streaming:
 *   - SSE content_block_start/content_block_delta/content_block_stop → OpenAI chunks
 *   - Tool-call opening delta on content_block_start
 *   - Thinking blocks forwarded as reasoning_content
 *
 */

import {
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessage,
    MessageRole,
    ToolDefinition,
    ToolCall,
} from '../types';
import { LLMClientError, computeCost } from '../llm-client';
import { getLogger } from '../logger';

const ANTHROPIC_API_VERSION = '2023-06-01';

// ─── Anthropic request types ────────────────────────────────────────

interface AnthropicContentBlock {
    type: string;
    text?: string;
    // tool_use
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    // tool_result
    tool_use_id?: string;
    content?: string | AnthropicContentBlock[];
    // image
    source?: { type: string; media_type: string; data: string };
}

interface AnthropicToolDef {
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
}

interface AnthropicRequest {
    model: string;
    messages: { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }[];
    system?: string;
    max_tokens: number;
    stream?: boolean;
    temperature?: number;
    stop_sequences?: string[];
    tools?: AnthropicToolDef[];
    tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
    thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'disabled' };
}

// ─── Anthropic response types ────────────────────────────────────────

interface AnthropicUsage {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
}

interface AnthropicResponse {
    id: string;
    model: string;
    role: 'assistant';
    content: AnthropicContentBlock[];
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: AnthropicUsage;
}

// ─── SSE event types ─────────────────────────────────────────────────

interface AnthropicSSEEvent {
    type: 'message_start' | 'content_block_start' | 'content_block_delta' |
          'content_block_stop' | 'message_delta' | 'message_stop' | 'ping';
    message?: AnthropicResponse;
    content_block?: AnthropicContentBlock;
    index?: number;
    delta?: {
        type?: string;
        text?: string;
        partial_json?: string;
        thinking?: string;
        signature?: string;
        // On `message_delta`, Anthropic carries the final stop reason here.
        stop_reason?: string;
    };
    usage?: { output_tokens: number };
}

// ─── Request preparation ────────────────────────────────────────────

/**
 * Convert OpenAI ChatCompletionRequest to Anthropic Messages API format.
 * Returns the modified request with an additional `_anthropicReq` property
 * containing the Anthropic-specific payload.
 */
export function prepareAnthropicRequest(req: ChatCompletionRequest): ChatCompletionRequest {
    // Extract system messages
    const systemMessages: string[] = [];
    const nonSystemMessages: ChatMessage[] = [];

    for (const msg of req.messages) {
        if (msg.role === MessageRole.System) {
            const text = typeof msg.content === 'string' ? msg.content : '';
            if (text) systemMessages.push(text);
        } else {
            nonSystemMessages.push(msg);
        }
    }

    // Convert messages to Anthropic format
    const anthropicMessages: { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }[] = [];

    for (const msg of nonSystemMessages) {
        const role = msg.role === MessageRole.Assistant ? 'assistant' as const : 'user' as const;
        const blocks = convertMessageToAnthropicBlocks(msg);
        anthropicMessages.push({ role, content: blocks });
    }

    // Convert tools
    const anthropicTools: AnthropicToolDef[] | undefined = req.tools?.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));

    const anthropicReq: AnthropicRequest = {
        model: req.model,
        messages: anthropicMessages,
        max_tokens: req.maxTokens ?? 4096,
        stream: req.stream ?? true,
        temperature: req.temperature,
        ...(systemMessages.length > 0 && { system: systemMessages.join('\n\n') }),
        ...(anthropicTools && anthropicTools.length > 0 && { tools: anthropicTools }),
        ...(req.toolChoice === 'auto' && { tool_choice: { type: 'auto' } }),
        ...((req.toolChoice as any)?.function?.name && {
            tool_choice: { type: 'tool', name: (req.toolChoice as any).function.name },
        }),
    };

    // Attach the Anthropic payload to the request for custom send path
    (req as any)._anthropicReq = anthropicReq;
    (req as any)._anthropicSystem = systemMessages.join('\n\n') || undefined;

    return req;
}

function convertMessageToAnthropicBlocks(msg: ChatMessage): string | AnthropicContentBlock[] {
    // Tool result messages
    if (msg.role === MessageRole.Tool && msg.toolCallId) {
        const content = typeof msg.content === 'string' ? msg.content : '';
        return [{
            type: 'tool_result',
            tool_use_id: msg.toolCallId,
            content,
        }];
    }

    // Assistant messages with tool calls
    if (msg.role === MessageRole.Assistant && msg.toolCalls && msg.toolCalls.length > 0) {
        const blocks: AnthropicContentBlock[] = [];

        // Add text content if present
        const textContent = typeof msg.content === 'string' ? msg.content : '';
        if (textContent) {
            blocks.push({ type: 'text', text: textContent });
        }

        // Add tool_use blocks
        for (const tc of msg.toolCalls) {
            let input: Record<string, unknown> = {};
            try {
                input = JSON.parse(tc.function.arguments);
            } catch { /* leave empty */ }
            blocks.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input,
            });
        }

        return blocks;
    }

    // Plain text messages
    if (typeof msg.content === 'string') {
        return msg.content;
    }

    // Multimodal messages
    const blocks: AnthropicContentBlock[] = [];
    for (const part of msg.content) {
        if (part.type === 'text') {
            blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
            // Extract base64 data from data URL
            const url = part.image_url.url;
            const commaIdx = url.indexOf(',');
            const mediaType = url.substring(5, commaIdx > 0 ? url.indexOf(';') : url.length);
            const data = commaIdx > 0 ? url.substring(commaIdx + 1) : url;
            blocks.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: mediaType || 'image/png',
                    data,
                },
            });
        }
    }

    return blocks.length > 0 ? blocks : '';
}

// ─── Response transformation ────────────────────────────────────────

export function transformAnthropicResponse(
    anthropicResp: AnthropicResponse,
    requestModel: string,
): ChatCompletionResponse {
    const choices: any[] = [];
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const block of anthropicResp.content) {
        if (block.type === 'text' && block.text) {
            textParts.push(block.text);
        } else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id || '',
                type: 'function',
                function: {
                    name: block.name || '',
                    arguments: JSON.stringify(block.input || {}),
                },
            });
        }
    }

    const finishReason = mapAnthropicStopReason(anthropicResp.stop_reason);

    choices.push({
        index: 0,
        message: {
            role: MessageRole.Assistant,
            content: textParts.join(''),
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finishReason,
    });

    return {
        id: anthropicResp.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: requestModel,
        choices,
        usage: {
            promptTokens: anthropicResp.usage.input_tokens,
            completionTokens: anthropicResp.usage.output_tokens,
            totalTokens: anthropicResp.usage.input_tokens + anthropicResp.usage.output_tokens,
            cachedTokens: anthropicResp.usage.cache_read_input_tokens,
            cacheCreationTokens: anthropicResp.usage.cache_creation_input_tokens,
            costUsd: computeCost(
                requestModel,
                anthropicResp.usage.input_tokens,
                anthropicResp.usage.output_tokens,
                anthropicResp.usage.cache_read_input_tokens,
                anthropicResp.usage.cache_creation_input_tokens,
            ),
        },
    };
}

function mapAnthropicStopReason(reason: string | null): string {
    switch (reason) {
        case 'end_turn': return 'stop';
        case 'max_tokens': return 'length';
        case 'stop_sequence': return 'stop';
        case 'tool_use': return 'tool_calls';
        default: return 'stop';
    }
}

// ─── HTTP send functions ────────────────────────────────────────────

function buildAnthropicHeaders(apiKey: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
    };
}

export async function sendAnthropicNonStreamingRequest(
    apiKey: string,
    req: ChatCompletionRequest,
    abortController: AbortController,
): Promise<ChatCompletionResponse> {
    const anthropicReq = (req as any)._anthropicReq as AnthropicRequest;
    if (!anthropicReq) throw new Error('Anthropic request not prepared');

    anthropicReq.stream = false;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: buildAnthropicHeaders(apiKey),
        body: JSON.stringify(anthropicReq),
        signal: abortController.signal,
    });

    if (!response.ok) {
        const errorText = (await response.text()).slice(0, 1000);
        throw new LLMClientError(`Anthropic HTTP ${response.status}: ${errorText}`);
    }

    const data: AnthropicResponse = await response.json();
    return transformAnthropicResponse(data, req.model);
}

export async function sendAnthropicStreamingRequest(
    apiKey: string,
    req: ChatCompletionRequest,
    onChunk: (chunk: ChatCompletionResponse) => void,
    abortController: AbortController,
): Promise<ChatCompletionResponse> {
    const anthropicReq = (req as any)._anthropicReq as AnthropicRequest;
    if (!anthropicReq) throw new Error('Anthropic request not prepared');

    anthropicReq.stream = true;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: buildAnthropicHeaders(apiKey),
        body: JSON.stringify(anthropicReq),
        signal: abortController.signal,
    });

    if (!response.ok) {
        const errorText = (await response.text()).slice(0, 1000);
        throw new LLMClientError(`Anthropic HTTP ${response.status}: ${errorText}`);
    }

    return parseAnthropicStream(response, req.model, onChunk);
}

async function parseAnthropicStream(
    response: globalThis.Response,
    modelId: string,
    onChunk: (chunk: ChatCompletionResponse) => void,
): Promise<ChatCompletionResponse> {
    const reader = response.body?.getReader();
    if (!reader) throw new LLMClientError('Response body not readable');

    const decoder = new TextDecoder();
    let buffer = '';

    // Track message-level state
    let messageId = '';
    let currentTextIndex = -1;
    let currentToolUseIndex = -1;
    const textContents: string[] = [];
    const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let stopReason = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;

                const data = trimmed.slice(6);
                try {
                    const event: AnthropicSSEEvent = JSON.parse(data);

                    switch (event.type) {
                        case 'message_start':
                            if (event.message) {
                                messageId = event.message.id;
                                inputTokens = event.message.usage.input_tokens;
                                cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0;
                                cacheCreationTokens = event.message.usage.cache_creation_input_tokens ?? 0;
                                outputTokens = event.message.usage.output_tokens;
                            }
                            break;

                        case 'content_block_start': {
                            const block = event.content_block;
                            if (!block) break;
                            if (block.type === 'text') {
                                currentTextIndex = event.index ?? textContents.length;
                                textContents[currentTextIndex] = '';
                            } else if (block.type === 'tool_use') {
                                currentToolUseIndex = event.index ?? toolCalls.size;
                                toolCalls.set(currentToolUseIndex, {
                                    id: block.id || '',
                                    name: block.name || '',
                                    args: '',
                                });
                                // Emit tool-call start chunk
                                onChunk({
                                    id: messageId,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model: modelId,
                                    choices: [{
                                        index: 0,
                                        delta: {
                                            toolCalls: [{
                                                index: currentToolUseIndex,
                                                id: block.id,
                                                type: 'function',
                                                function: { name: block.name || '', arguments: '' },
                                            }],
                                        },
                                    }],
                                });
                            }
                            break;
                        }

                        case 'content_block_delta': {
                            const delta = event.delta;
                            if (!delta) break;
                            if (delta.type === 'text_delta' && delta.text) {
                                const idx = event.index ?? currentTextIndex;
                                if (idx >= 0) {
                                    textContents[idx] = (textContents[idx] || '') + delta.text;
                                    onChunk({
                                        id: messageId,
                                        object: 'chat.completion.chunk',
                                        created: Math.floor(Date.now() / 1000),
                                        model: modelId,
                                        choices: [{
                                            index: 0,
                                            delta: { content: delta.text },
                                        }],
                                    });
                                }
                            } else if (delta.type === 'input_json_delta' && delta.partial_json) {
                                const idx = event.index ?? currentToolUseIndex;
                                const tc = toolCalls.get(idx);
                                if (tc) {
                                    tc.args += delta.partial_json;
                                    onChunk({
                                        id: messageId,
                                        object: 'chat.completion.chunk',
                                        created: Math.floor(Date.now() / 1000),
                                        model: modelId,
                                        choices: [{
                                            index: 0,
                                            delta: {
                                                toolCalls: [{
                                                    index: idx,
                                                    function: { name: '', arguments: delta.partial_json },
                                                }],
                                            },
                                        }],
                                    });
                                }
                            } else if (delta.type === 'thinking_delta' && delta.thinking) {
                                onChunk({
                                    id: messageId,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model: modelId,
                                    choices: [{
                                        index: 0,
                                        delta: { reasoningContent: delta.thinking },
                                    }],
                                });
                            }
                            break;
                        }

                        case 'content_block_stop':
                            // Block complete — nothing to emit
                            break;

                        case 'message_delta':
                            // Anthropic delivers the final stop reason on the
                            // message_delta event's delta.stop_reason field.
                            if (event.delta?.stop_reason) {
                                stopReason = mapAnthropicStopReason(event.delta.stop_reason);
                            }
                            if (event.usage?.output_tokens) {
                                outputTokens = event.usage.output_tokens;
                            }
                            break;

                        case 'message_stop':
                            // Emit final aggregated response
                            break;
                    }
                } catch {
                    // Silently skip parse errors in streaming
                }
            }
        }

        // Build final aggregated response
        const aggregatedContent = textContents.join('');
        const aggregatedToolCalls: ToolCall[] = [];
        for (const tc of toolCalls.values()) {
            if (tc.id) {
                aggregatedToolCalls.push({
                    id: tc.id,
                    type: 'function',
                    function: {
                        name: tc.name,
                        arguments: tc.args || '{}',
                    },
                });
            }
        }

        const finalResponse: ChatCompletionResponse = {
            id: messageId || 'unknown',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{
                index: 0,
                message: {
                    role: MessageRole.Assistant,
                    content: aggregatedContent,
                    toolCalls: aggregatedToolCalls.length > 0 ? aggregatedToolCalls : undefined,
                },
                finishReason: stopReason || 'stop',
            }],
            usage: {
                promptTokens: inputTokens,
                completionTokens: outputTokens,
                totalTokens: inputTokens + outputTokens,
                cachedTokens: cacheReadTokens,
                cacheCreationTokens: cacheCreationTokens,
                costUsd: computeCost(modelId, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens),
            },
        };

        return finalResponse;
    } finally {
        reader.releaseLock();
    }
}

export function getAnthropicBaseUrl(): string {
    return 'https://api.anthropic.com/v1';
}
