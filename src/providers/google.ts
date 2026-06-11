/**
 * Google Gemini provider via native Gemini API.
 *
 * @deprecated Use the native sendGeminiStreamingRequest / sendGeminiNonStreamingRequest
 *             through the ProviderHandler.customSend path. This function is retained
 *             only for backward compatibility with tests and is a no-op.
 */
export function prepareGoogleRequest(_req: ChatCompletionRequest): void {
    // No-op — native API path handles everything in customSend
}

/**
 * Google Gemini provider native API implementation.
 *
 * Uses Google's native Gemini API (not the OpenAI-compatible endpoint) to get
 * visible thinking/reasoning text. The native API returns thought content as
 * dedicated parts with `thought: true`, which we map to reasoning_content.
 *
 * API Reference: https://ai.google.dev/gemini-api/docs/thinking
 *
 * Request (OpenAI → Gemini):
 *   - Messages → contents array with role mapping
 *   - System prompt → systemInstruction
 *   - Tools → functionDeclarations in a tools array
 *   - Max_tokens → generationConfig.maxOutputTokens
 *   - Temperature → generationConfig.temperature (dropped for thinking models)
 *
 * Response (Gemini → OpenAI):
 *   - Thought parts → reasoning_content
 *   - Text parts → content
 *   - Function call parts → tool_calls
 *   - finishReason → finish_reason
 *   - usageMetadata → usage (prompt_tokens/completion_tokens)
 *
 * Streaming:
 *   - SSE with JSON chunks (data: {...}\n\n)
 *   - Each chunk is a partial or complete candidate with content.parts
 *   - Accumulate parts across chunks, emit OpenAI-compatible deltas
 *
 * Auth: x-goog-api-key header (not Bearer)
 */

import {
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessage,
    MessageRole,
    ToolDefinition,
    ToolCall,
    UsageInfo,
    ChatChoice,
    ChatDelta,
} from '../types';
import { LLMClientError } from '../llm-client';
import { getLogger } from '../logger';

// ─── Gemini native API types ─────────────────────────────────────────

interface GeminiPart {
    text?: string;
    thought?: boolean;
    thoughtSignature?: string;
    // function call
    functionCall?: {
        name: string;
        args: Record<string, unknown>;
    };
    // function response
    functionResponse?: {
        name: string;
        response: Record<string, unknown>;
    };
    // inline data (images)
    inlineData?: {
        mimeType: string;
        data: string; // base64
    };
    // file data (images via URL)
    fileData?: {
        mimeType: string;
        fileUri: string;
    };
}

interface GeminiContent {
    role?: string; // "user", "model", "function" — absent for systemInstruction
    parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
}

interface GeminiTool {
    functionDeclarations?: GeminiFunctionDeclaration[];
    // could also have googleSearch etc.
}

interface GeminiGenerationConfig {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    stopSequences?: string[];
    thinkingConfig?: {
        thinkingBudget?: number;
        includeThoughts?: boolean;
    };
}

interface GeminiRequest {
    contents: GeminiContent[];
    systemInstruction?: GeminiContent;
    tools?: GeminiTool[];
    generationConfig?: GeminiGenerationConfig;
    safetySettings?: Array<{
        category: string;
        threshold: string;
    }>;
}

interface GeminiCandidate {
    content: GeminiContent;
    finishReason?: string;
    index?: number;
    safetyRatings?: unknown[];
}

interface GeminiUsageMetadata {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
    /** Tokens consumed by cached (context-cached) content reads (Gemini 2.x). */
    cachedContentTokenCount?: number;
    /** Tokens consumed by thinking/reasoning (Gemini 2.x+ thinking models). */
    thoughtsTokenCount?: number;
}

interface GeminiResponse {
    candidates: GeminiCandidate[];
    usageMetadata?: GeminiUsageMetadata;
    modelVersion?: string;
    responseId?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────

const GEMINI_NATIVE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Recursively strip `additionalProperties` from an object.
 *
 * Gemini's native API rejects function declaration schemas that contain
 * `additionalProperties` (it only supports a strict OpenAPI 3.0 subset).
 * The schemas coming from VS Code contain `additionalProperties: false`
 * (standard JSON Schema), which must be removed before sending.
 */
function stripAdditionalProperties(obj: Record<string, unknown>): Record<string, unknown> {
    if (typeof obj !== 'object' || obj === null) {
        return obj;
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (key === 'additionalProperties') {
            continue;
        }
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            result[key] = stripAdditionalProperties(value as Record<string, unknown>);
        } else if (Array.isArray(value)) {
            result[key] = value.map((item) =>
                typeof item === 'object' && item !== null
                    ? stripAdditionalProperties(item as Record<string, unknown>)
                    : item
            );
        } else {
            result[key] = value;
        }
    }
    return result;
}

function roleToGemini(role: MessageRole): string {
    switch (role) {
        case MessageRole.User: return 'user';
        case MessageRole.Assistant: return 'model';
        case MessageRole.Tool: return 'user'; // Gemini has no "function" role — functionResponse parts go inside user messages
        default: return 'user';
    }
}

function roleFromGemini(role: string | undefined): MessageRole {
    switch (role) {
        case 'user': return MessageRole.User;
        case 'model': return MessageRole.Assistant;
        default: return MessageRole.User;
    }
}

/**
 * Translate an OpenAI ChatMessage to a Gemini Content.
 */
function messageToGeminiContent(msg: ChatMessage): GeminiContent {
    const parts: GeminiPart[] = [];

    const isToolResult = msg.role === MessageRole.Tool;

    // Handle content (text or multimodal)
    // For tool results, the content goes inside functionResponse — skip standalone text parts.
    if (!isToolResult) {
        if (typeof msg.content === 'string') {
            if (msg.content.trim()) {
                parts.push({ text: msg.content });
            }
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'text' && part.text) {
                    parts.push({ text: part.text });
                } else if (part.type === 'image_url' && part.image_url?.url) {
                    const url = part.image_url.url;
                    if (url.startsWith('data:')) {
                        // data:image/png;base64,...
                        const commaIdx = url.indexOf(',');
                        const mimeType = url.substring(5, commaIdx).split(';')[0];
                        const base64data = url.substring(commaIdx + 1);
                        parts.push({
                            inlineData: { mimeType, data: base64data },
                        });
                    } else {
                        // Regular URL
                        const mimeType = url.endsWith('.png') ? 'image/png'
                            : url.endsWith('.jpg') || url.endsWith('.jpeg') ? 'image/jpeg'
                            : url.endsWith('.gif') ? 'image/gif'
                            : 'image/png';
                        parts.push({
                            fileData: { mimeType, fileUri: url },
                        });
                    }
                }
            }
        }
    }

    // Handle tool calls (assistant)
    if (msg.toolCalls && msg.toolCalls.length > 0 && msg.role === MessageRole.Assistant) {
        for (const tc of msg.toolCalls) {
            let args: Record<string, unknown> = {};
            try {
                args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
            } catch {
                args = {};
            }
            parts.push({
                functionCall: { name: tc.function.name, args },
            });
        }
    }

    // Handle tool response
    if (isToolResult && msg.toolCallId) {
        // Gemini needs the function name — extract from content or use toolCallId as name
        // The function name comes from the preceding function call
        const functionName = (msg as any).functionName || msg.toolCallId;
        const responseContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        parts.push({
            functionResponse: {
                name: functionName,
                response: {
                    name: functionName,
                    content: responseContent,
                },
            },
        });
    }

    // Ensure at least one part
    if (parts.length === 0) {
        parts.push({ text: ' ' });
    }

    return { role: roleToGemini(msg.role), parts };
}

/**
 * Build the Gemini native API request payload from an OpenAI-compatible request.
 */
function buildGeminiRequest(request: ChatCompletionRequest): GeminiRequest {
    const geminiReq: GeminiRequest = {
        contents: [],
    };

    const messages = request.messages || [];

    // Separate system messages (Gemini uses systemInstruction)
    const systemTexts: string[] = [];
    const contentMessages: ChatMessage[] = [];

    for (const msg of messages) {
        if (msg.role === MessageRole.System) {
            if (typeof msg.content === 'string') {
                systemTexts.push(msg.content);
            } else if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === 'text' && part.text) {
                        systemTexts.push(part.text);
                    }
                }
            }
        } else {
            contentMessages.push(msg);
        }
    }

    if (systemTexts.length > 0) {
        geminiReq.systemInstruction = {
            parts: [{ text: systemTexts.join('\n\n') }],
        };
    }

    // Convert non-system messages to Gemini contents
    // Merge consecutive messages with same role (Gemini requires alternating user/model)
    const mergedContents: GeminiContent[] = [];
    for (const msg of contentMessages) {
        const content = messageToGeminiContent(msg);
        const lastContent = mergedContents[mergedContents.length - 1];

        if (lastContent && lastContent.role === content.role) {
            // Merge parts
            lastContent.parts.push(...content.parts);
        } else {
            mergedContents.push(content);
        }
    }

    geminiReq.contents = mergedContents;

    // Tools
    if (request.tools && request.tools.length > 0) {
        const functionDecls: GeminiFunctionDeclaration[] = request.tools
            .filter(t => t.type === 'function')
            .map(t => ({
                name: t.function.name,
                description: t.function.description,
                parameters: t.function.parameters
                    ? stripAdditionalProperties(t.function.parameters as Record<string, unknown>) as Record<string, unknown>
                    : undefined,
            }));

        if (functionDecls.length > 0) {
            geminiReq.tools = [{ functionDeclarations: functionDecls }];
        }
    }

    // Generation config
    const genConfig: GeminiGenerationConfig = {};

    if (request.maxTokens && request.maxTokens > 0) {
        genConfig.maxOutputTokens = request.maxTokens;
    }

    // Gemini 3.x thinking models: always enable visible thoughts
    // Drop temperature for thinking models (only default supported)
    const modelId = request.model;
    const isThinkingModel = modelId.startsWith('gemini-3');
    if (isThinkingModel) {
        genConfig.thinkingConfig = { includeThoughts: true };
    } else if (request.temperature !== undefined) {
        genConfig.temperature = request.temperature;
    }

    geminiReq.generationConfig = genConfig;

    return geminiReq;
}

/**
 * Parse a Gemini part into OpenAI-compatible delta content.
 * Returns partial delta content for streaming accumulation.
 */
function partToDelta(part: GeminiPart): {
    content?: string;
    reasoningContent?: string;
    toolCall?: Partial<ToolCall> & { index?: number };
} {
    if (part.thought) {
        return { reasoningContent: part.text || '' };
    }

    if (part.text) {
        return { content: part.text };
    }

    if (part.functionCall) {
        return {
            toolCall: {
                id: part.functionCall.name, // Gemini doesn't have call IDs — use name
                type: 'function',
                function: {
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args),
                },
            },
        };
    }

    return {};
}

// ─── Public functions ─────────────────────────────────────────────────

/**
 * Custom send path: non-streaming native Gemini API call.
 */
export async function sendGeminiNonStreamingRequest(
    apiKey: string,
    request: ChatCompletionRequest,
    abortController: AbortController,
): Promise<ChatCompletionResponse> {
    const modelId = request.model;
    const url = `${GEMINI_NATIVE_BASE_URL}/${modelId}:generateContent`;

    const geminiReq = buildGeminiRequest(request);
    const body = JSON.stringify(geminiReq);

    getLogger().debug(`[GOOGLE-NATIVE] POST ${url} (${body.length} bytes)`);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
        },
        body,
        signal: abortController.signal,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new LLMClientError(`Gemini HTTP ${response.status}: ${errorText}`);
    }

    const geminiResp: GeminiResponse = await response.json();
    return geminiToOpenAIResponse(geminiResp, modelId);
}

/**
 * Custom send path: streaming native Gemini API call.
 */
export async function sendGeminiStreamingRequest(
    apiKey: string,
    request: ChatCompletionRequest,
    onChunk: (chunk: ChatCompletionResponse) => void,
    abortController: AbortController,
): Promise<ChatCompletionResponse> {
    const modelId = request.model;
    const url = `${GEMINI_NATIVE_BASE_URL}/${modelId}:streamGenerateContent?alt=sse`;

    const geminiReq = buildGeminiRequest(request);
    const body = JSON.stringify(geminiReq);

    getLogger().debug(`[GOOGLE-NATIVE] POST ${url} (${body.length} bytes)`);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
        },
        body,
        signal: abortController.signal,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new LLMClientError(`Gemini HTTP ${response.status}: ${errorText}`);
    }

    return parseGeminiStream(response, modelId, onChunk);
}

/**
 * Parse SSE streaming response from Gemini's native streaming endpoint.
 */
async function parseGeminiStream(
    response: globalThis.Response,
    modelId: string,
    onChunk: (chunk: ChatCompletionResponse) => void,
): Promise<ChatCompletionResponse> {
    const reader = response.body?.getReader();
    if (!reader) throw new LLMClientError('Response body is not readable');

    const decoder = new TextDecoder();
    let buffer = '';
    let aggregatedText = '';
    let aggregatedReasoning = '';
    let responseId = '';
    let modelVersion = '';
    let finishReason = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cacheReadTokens = 0;
    let reasoningTokens = 0;

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
                if (data === '[DONE]') continue;

                try {
                    const geminiChunk: GeminiResponse = JSON.parse(data);

                    // Track response metadata
                    if (geminiChunk.responseId) responseId = geminiChunk.responseId;
                    if (geminiChunk.modelVersion) modelVersion = geminiChunk.modelVersion;

                    // Track usage
                    if (geminiChunk.usageMetadata) {
                        promptTokens = geminiChunk.usageMetadata.promptTokenCount;
                        completionTokens = Math.max(completionTokens, geminiChunk.usageMetadata.candidatesTokenCount);
                        totalTokens = geminiChunk.usageMetadata.totalTokenCount;
                        cacheReadTokens = Math.max(cacheReadTokens, geminiChunk.usageMetadata.cachedContentTokenCount ?? 0);
                        reasoningTokens = Math.max(reasoningTokens, geminiChunk.usageMetadata.thoughtsTokenCount ?? 0);
                    }

                    // Process candidates
                    for (const candidate of geminiChunk.candidates || []) {
                        if (candidate.finishReason) {
                            finishReason = mapGeminiFinishReason(candidate.finishReason);
                        }

                        if (candidate.content?.parts) {
                            for (const part of candidate.content.parts) {
                                const delta = partToDelta(part);

                                if (delta.reasoningContent) {
                                    aggregatedReasoning += delta.reasoningContent;
                                    const chunk: ChatCompletionResponse = {
                                        id: responseId,
                                        object: 'chat.completion.chunk',
                                        created: Math.floor(Date.now() / 1000),
                                        model: modelVersion || modelId,
                                        choices: [{
                                            index: 0,
                                            delta: {
                                                reasoningContent: delta.reasoningContent,
                                            },
                                        }],
                                    };
                                    onChunk(chunk);
                                }

                                if (delta.content) {
                                    aggregatedText += delta.content;
                                    const chunk: ChatCompletionResponse = {
                                        id: responseId,
                                        object: 'chat.completion.chunk',
                                        created: Math.floor(Date.now() / 1000),
                                        model: modelVersion || modelId,
                                        choices: [{
                                            index: 0,
                                            delta: {
                                                content: delta.content,
                                            },
                                        }],
                                    };
                                    onChunk(chunk);
                                }

                                if (delta.toolCall) {
                                    // Emit tool call immediately
                                    const chunk: ChatCompletionResponse = {
                                        id: responseId,
                                        object: 'chat.completion.chunk',
                                        created: Math.floor(Date.now() / 1000),
                                        model: modelVersion || modelId,
                                        choices: [{
                                            index: 0,
                                            delta: {
                                                toolCalls: [delta.toolCall],
                                            },
                                        }],
                                    };
                                    onChunk(chunk);
                                }
                            }
                        }
                    }
                } catch (parseError) {
                    getLogger().warning(`[GOOGLE-NATIVE] Failed to parse SSE chunk: ${parseError}`);
                }
            }
        }

        // Build final aggregated response
        const usage: UsageInfo = {
            promptTokens,
            completionTokens,
            totalTokens,
            cacheReadTokens,
            reasoningTokens,
        };

        return {
            id: responseId || 'unknown',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: modelVersion || modelId,
            choices: [{
                index: 0,
                message: {
                    role: MessageRole.Assistant,
                    content: aggregatedText,
                    reasoningContent: aggregatedReasoning || undefined,
                },
                finishReason: finishReason || 'stop',
            }],
            usage,
        };
    } finally {
        reader.releaseLock();
    }
}

/**
 * Convert a non-streaming Gemini response to OpenAI format.
 */
function geminiToOpenAIResponse(
    geminiResp: GeminiResponse,
    modelId: string,
): ChatCompletionResponse {
    let content = '';
    let reasoningContent = '';
    const toolCalls: ToolCall[] = [];

    for (const candidate of geminiResp.candidates || []) {
        if (candidate.content?.parts) {
            for (const part of candidate.content.parts) {
                if (part.thought) {
                    reasoningContent += (reasoningContent ? '\n' : '') + (part.text || '');
                } else if (part.text) {
                    content += (content ? '\n' : '') + part.text;
                } else if (part.functionCall) {
                    toolCalls.push({
                        id: part.functionCall.name,
                        type: 'function',
                        function: {
                            name: part.functionCall.name,
                            arguments: JSON.stringify(part.functionCall.args),
                        },
                    });
                }
            }
        }
    }

    const finishReason = geminiResp.candidates?.[0]?.finishReason
        ? mapGeminiFinishReason(geminiResp.candidates[0].finishReason)
        : 'stop';

    const usage: UsageInfo | undefined = geminiResp.usageMetadata ? {
        promptTokens: geminiResp.usageMetadata.promptTokenCount,
        completionTokens: geminiResp.usageMetadata.candidatesTokenCount,
        totalTokens: geminiResp.usageMetadata.totalTokenCount,
        cacheReadTokens: geminiResp.usageMetadata.cachedContentTokenCount,
        reasoningTokens: geminiResp.usageMetadata.thoughtsTokenCount,
    } : undefined;

    return {
        id: geminiResp.responseId || 'unknown',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: geminiResp.modelVersion || modelId,
        choices: [{
            index: 0,
            message: {
                role: MessageRole.Assistant,
                content,
                reasoningContent: reasoningContent || undefined,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            },
            finishReason,
        }],
        usage,
    };
}

function mapGeminiFinishReason(reason: string): string {
    switch (reason) {
        case 'STOP': return 'stop';
        case 'MAX_TOKENS': return 'length';
        case 'SAFETY': return 'content_filter';
        case 'RECITATION': return 'content_filter';
        case 'OTHER':
        case 'FINISH_REASON_UNSPECIFIED':
        default:
            return 'stop';
    }
}

/** Google's native API base URL. */
export function getGoogleBaseUrl(): string {
    return GEMINI_NATIVE_BASE_URL;
}
