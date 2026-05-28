/**
 * Shared types for the Shofer LLM Router extension.
 *
 * These types mirror the llm-router Go types but in idiomatic TypeScript
 * for direct use within the VSCode extension host.
 */

// ─── Provider enumeration ───────────────────────────────────────────

export enum ProviderType {
    OpenAI = 'openai',
    Anthropic = 'anthropic',
    Google = 'google',
    DeepSeek = 'deepseek',
    MiniMax = 'minimax',
    Moonshot = 'moonshot',
    Xiaomi = 'xiaomi',
    Zhipu = 'zhipu',
    OpenRouter = 'openrouter',
}

// ─── Model registry ─────────────────────────────────────────────────

export interface ModelPricing {
    /** USD per 1K prompt tokens (text/image) */
    prompt?: number;
    /** USD per 1K completion tokens */
    completion?: number;
    /** USD per 1K prompt tokens for context > 200K */
    promptAbove200K?: number;
    /** USD per 1K completion tokens for context > 200K */
    completionAbove200K?: number;
    /** USD per 1K audio prompt tokens */
    audioPrompt?: number;
    /** USD per 1K audio completion tokens */
    audioCompletion?: number;
    /** USD per 1K cached input read tokens */
    contextCacheRead?: number;
    /** USD per 1K cached input write tokens */
    contextCacheWrite?: number;
    /** Batch discount factor (e.g. 0.5 = 50% off) */
    discount?: number;
}

export interface ModelRegistryEntry {
    id: string;
    name: string;
    description: string;
    contextLength: number;
    maxOutputTokens: number;
    provider: ProviderType;
    pricing: ModelPricing;
    imageInput: boolean;
    toolCalling: boolean;
}

// ─── Chat message types (OpenAI-compatible) ─────────────────────────

export enum MessageRole {
    System = 'system',
    User = 'user',
    Assistant = 'assistant',
    Tool = 'tool',
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
    index?: number;
}

export type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ChatMessage {
    role: MessageRole;
    content: string | ContentPart[];
    toolCallId?: string;
    toolCalls?: ToolCall[];
    reasoningContent?: string;
    /** Provider-specific extra body fields (e.g., MiniMax reasoning_details) */
    extraBody?: Record<string, unknown>;
}

export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
        strict?: boolean;
    };
}

export interface ChatCompletionRequest {
    conversationId: string;
    parentConversationId?: string;
    rootConversationId?: string;
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    tools?: ToolDefinition[];
    toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
    reasoningEffort?: string;
    extraBody?: Record<string, unknown>;
}

export interface ChatDelta {
    role?: MessageRole;
    content?: string;
    toolCalls?: Partial<ToolCall>[];
    reasoningContent?: string;
}

export interface ChatChoice {
    index: number;
    message?: ChatMessage;
    delta?: ChatDelta;
    finishReason?: string;
}

export interface UsageInfo {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd?: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
}

export interface ChatCompletionResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: ChatChoice[];
    usage?: UsageInfo;
}

// ─── Provider client interface ──────────────────────────────────────

export interface ProviderClient {
    /** Send a non-streaming chat completion request */
    sendRequest(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
    /** Send a streaming chat completion request, calling onChunk for each SSE delta */
    sendStreamingRequest(
        req: ChatCompletionRequest,
        onChunk: (chunk: ChatCompletionResponse) => void,
        abortController: AbortController
    ): Promise<ChatCompletionResponse>;
}

// ─── Composite model types ──────────────────────────────────────────

export type CompositeStrategy = 'failover' | 'round_robin';

export interface ThrottlingConfig {
    maxConcurrent: number;
    requestsPerWindow: number;
    windowMinutes: number;
}

export interface CompositeModelConfig {
    strategy: CompositeStrategy;
    models: string[];
    throttling?: ThrottlingConfig;
    perAttemptTimeoutMs?: number;
    totalTimeoutMs?: number;
}

// ─── Provider configuration ─────────────────────────────────────────

export interface ProviderApiKeys {
    openai?: string;
    anthropic?: string;
    google?: string;
    deepseek?: string;
    minimax?: string;
    moonshot?: string;
    xiaomi?: string;
    zhipu?: string;
    openrouter?: string;
}

export interface RouterConfig {
    enabled: boolean;
    defaultModel: string;
    timeout: number;
    compositeModelsFile: string;
    debug: boolean;
}

// ─── Model info (for VS Code LM API) ────────────────────────────────

export interface ModelCapabilities {
    imageInput: boolean;
    toolCalling: boolean;
    promptCache: boolean;
}

/** Pricing in USD per 1M tokens (the form Shofer expects). */
export interface ModelPricingPerMillion {
    inputPrice: number;
    outputPrice: number;
    cacheReadsPrice?: number;
    cacheWritesPrice?: number;
}

export interface ProviderModelInfo {
    id: string;
    name: string;
    family: string;
    version: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    capabilities: ModelCapabilities;
    pricing?: ModelPricingPerMillion;
}

// ─── Connection status ──────────────────────────────────────────────

export interface ConnectionStatus {
    isConnected: boolean;
    lastChecked: Date;
    error?: string;
}
