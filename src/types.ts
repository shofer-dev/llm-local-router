/**
 * Shared types for the Shofer LLM Router extension.
 *
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

export interface PerModelConfig {
    /** Model weight for smooth weighted round-robin (default: 1) */
    weight?: number;
    /** Per-model throttling overrides composite-level defaults */
    throttling?: ThrottlingConfig;
}

export interface CompositeHealthConfig {
    /** Consecutive failures before marking unhealthy (default: 3) */
    failureThreshold?: number;
    /** Cooldown in ms before probing an unhealthy model (default: 30000) */
    cooldownMs?: number;
    /** Consecutive failures to enter degraded state (default: 1) */
    degradedThreshold?: number;
}

export interface CompositeModelConfig {
    strategy: CompositeStrategy;
    /** List of underlying model IDs, or objects with per-model config */
    models: string[] | Array<string | { id: string; weight?: number; throttling?: ThrottlingConfig }>;
    /** Composite-level throttling (shared across all underlying models) */
    throttling?: ThrottlingConfig;
    /** Per-attempt timeout for non-streaming requests (ms, default: 120000) */
    perAttemptTimeoutMs?: number;
    /** Per-attempt inactivity timeout for streaming requests (ms, default: 30000).
     *  Reset on each received chunk — a steadily-streaming thinking model is never
     *  cancelled mid-response. */
    streamingTimeoutMs?: number;
    /** Total wall-clock timeout across all failovers (ms, default: 300000) */
    totalTimeoutMs?: number;
    /** Health monitoring configuration */
    health?: CompositeHealthConfig;
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
    /** Inline JSON configuration for composite models. Parsed when compositeModelsFile is not set. */
    compositeModelsConfig: string;
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

// ─── Metrics & observability ────────────────────────────────────────

/** Status of a single request for metrics aggregation. */
export type RequestStatus = 'success' | 'error' | 'timeout' | 'cancelled';

/** Classification of an error for metrics breakdown. */
export type ErrorType =
    | 'http_4xx'
    | 'http_5xx'
    | 'http_429'
    | 'timeout'
    | 'cancelled'
    | 'network_error'
    | 'parse_error'
    | 'unknown';

/**
 * Per-request metrics entry recorded by the MetricsCollector after every
 * chat completion attempt (success or failure).
 */
export interface MetricsRequestEntry {
    /** ISO timestamp of when the request was initiated. */
    timestamp: string;
    /** The model ID that was requested (may be composite, e.g. "shofer/code"). */
    modelId: string;
    /** The provider type (openai, anthropic, etc.) of the model that served. */
    provider: string;
    /** Whether the requested model was a composite model. */
    isComposite: boolean;
    /** For composite models, the composite model ID (same as modelId). */
    compositeModelId?: string;
    /** The underlying model that actually served the request. */
    servedByModel: string;
    /** Outcome. */
    status: RequestStatus;
    /** Error classification (only set when status !== 'success'). */
    errorType?: ErrorType;
    /** Human-readable error message (only set when status !== 'success'). */
    errorMessage?: string;
    /** Time to first byte in milliseconds. */
    ttfbMs: number;
    /** Time to last byte in milliseconds. */
    ttlbMs: number;
    /** Token usage (from the provider response). */
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
    /** USD cost computed from registry pricing × token usage. */
    costUsd: number;
    /** Whether failover occurred during composite routing. */
    failoverOccurred: boolean;
    /** Number of attempts before success (1 = first attempt succeeded). */
    attempts: number;
}

/** Per-model statistics aggregated over a 5-minute window. */
export interface ModelWindowStats {
    modelId: string;
    provider: string;
    isComposite: boolean;
    /** Total requests (all statuses). */
    requestCount: number;
    successCount: number;
    errorCount: number;
    timeoutCount: number;
    cancelledCount: number;
    /** Availability: successCount / (successCount + errorCount + timeoutCount). */
    availability: number;
    /** Latency samples for percentile computation (TTFB). */
    ttfbSamples: number[];
    /** Latency samples for percentile computation (TTLB). */
    ttlbSamples: number[];
    /** Precomputed percentiles. */
    ttfbP50: number;
    ttfbP90: number;
    ttfbP99: number;
    ttlbP50: number;
    ttlbP90: number;
    ttlbP99: number;
    /** Token aggregates. */
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalCachedTokens: number;
    totalCacheCreationTokens: number;
    /** USD cost aggregate. */
    totalCostUsd: number;
    /** Cache hit ratio: cachedTokens / (uncached + cached). */
    cacheHitRatio: number;
    /** Error type breakdown. */
    errorTypes: Record<string, number>;
}

/**
 * Routing distribution for a composite model: which underlying models
 * received how many requests.
 */
export interface CompositeDistribution {
    compositeModelId: string;
    /** underlyingModelId → request count. */
    modelCounts: Record<string, number>;
    /** Total failover events (requests where at least one failover happened). */
    failoverCount: number;
    /** Total mid-stream failures. */
    midstreamFailureCount: number;
    /** Total attempts across all requests. */
    totalAttempts: number;
}

/** A 5-minute time window of aggregated metrics. */
export interface MetricsWindow {
    /** Window start as ISO timestamp (aligned to 5-min boundary). */
    windowStart: string;
    /** Window end as ISO timestamp. */
    windowEnd: string;
    /** Per-model stats keyed by modelId. */
    models: Record<string, ModelWindowStats>;
    /** Composite routing distribution keyed by compositeModelId. */
    compositeRouting: Record<string, CompositeDistribution>;
}

/** Cross-window summary for a single model. */
export interface ModelSummary {
    modelId: string;
    provider: string;
    windowCount: number;
    totalRequests: number;
    totalSuccess: number;
    totalErrors: number;
    totalTimeouts: number;
    totalCancelled: number;
    availability: number;
    totalCostUsd: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    avgTtfbMs: number;
    avgTtlbMs: number;
    p90TtlbMs: number;
    cacheHitRatio: number;
}
