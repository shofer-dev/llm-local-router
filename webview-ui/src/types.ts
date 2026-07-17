/**
 * Webview-specific types for the LLM Local Router configuration UI.
 *
 * These mirror the host-side types from ../src/types.ts but are
 * self-contained for the webview build (which does not have access
 * to the extension host's node_modules or vscode API).
 */

// ─── Strategy ───────────────────────────────────────────────────

export type RoutingStrategy = 'failover' | 'round_robin' | 'lowest_latency' | 'highest_reliability';

// ─── Throttling ─────────────────────────────────────────────────

export interface ThrottlingConfig {
  maxConcurrent: number;
  requestsPerWindow: number;
  windowMinutes: number;
}

// ─── Health ─────────────────────────────────────────────────────

export interface HealthConfig {
  failureThreshold: number;
  degradedThreshold: number;
  cooldownMs: number;
}

// ─── Underlying model entry ─────────────────────────────────────

export interface UnderlyingModelEntry {
  modelId: string;
  provider: string;
  weight: number;
  priority: number;
}

// ─── Composite model config (webview-editable) ──────────────────

export interface CompositeModelConfig {
  modelId: string;
  strategy: RoutingStrategy;
  streamingTimeoutMs: number;
  nonStreamingTimeoutMs: number;
  totalTimeoutMs: number;
  health?: HealthConfig;
  throttling?: ThrottlingConfig;
  underlyingModels: UnderlyingModelEntry[];
  /** For lowest_latency strategy: sliding window in ms for TTFB averaging. Default 600000 (10 min). */
  latencyWindowMs?: number;
}

// ─── Model registry summary (for model picker) ──────────────────

export interface ModelRegistrySummary {
  id: string;
  name: string;
  provider: string;
  description: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  imageInput: boolean;
  toolCalling: boolean;
  promptCache: boolean;
}

// ─── Metrics data (for MetricsPanel) ─────────────────────────────

export interface ModelMetrics {
  modelId: string;
  provider: string;
  isComposite: boolean;
  requestCount: number;
  successCount: number;
  errorCount: number;
  timeoutCount: number;
  cancelledCount: number;
  availability: number;
  ttfbP50: number;
  ttfbP90: number;
  ttfbP99: number;
  ttlbP50: number;
  ttlbP90: number;
  ttlbP99: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
  cacheHitRatio: number;
  totalCostUsd: number;
  errorTypes: Record<string, number>;
}

export interface CompositeMetrics {
  compositeModelId: string;
  modelCounts: Record<string, number>;
  failoverCount: number;
  midstreamFailureCount: number;
  totalAttempts: number;
}

export interface MetricsPayload {
  windowStart: string;
  windowEnd: string;
  modelMetrics: ModelMetrics[];
  compositeMetrics: CompositeMetrics[];
}

// ─── Status data (for StatusPanel) ──────────────────────────────

export interface ProviderStatus {
  name: string;
  configured: boolean;
  modelCount: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  imageInput: boolean;
  toolCalling: boolean;
  promptCache: boolean;
  isComposite: boolean;
  pricing?: { inputPrice: number; outputPrice: number };
}

export interface StatusPayload {
  connected: boolean;
  enabled: boolean;
  providers: ProviderStatus[];
  models: ModelInfo[];
}

// ─── Provider config ────────────────────────────────────────────

/** Pricing in USD per 1M tokens. */
export interface ProviderPricing {
  /** USD per 1M prompt tokens */
  prompt?: number;
  /** USD per 1M completion tokens */
  completion?: number;
  /** USD per 1M cache read tokens */
  cacheRead?: number;
}

/** Per-model entry shown in the provider config panel. */
export interface ModelConfigEntry {
  /** Model ID (e.g. "gpt-5.5") */
  id: string;
  /** Display name (e.g. "GPT-5.5") */
  name: string;
  /** Default pricing from the model registry (USD per 1M tokens) */
  defaultPricing?: ProviderPricing;
  /** User-configured pricing override (USD per 1M tokens) */
  pricingOverride?: ProviderPricing;
}

export interface ProviderConfigEntry {
  id: string;
  label: string;
  hasApiKey: boolean;
  endpointUrl: string;
  defaultEndpoint: string;
  modelCount: number;
  /** Models registered with this provider, with registry-default pricing. */
  models: ModelConfigEntry[];
  /** Legacy provider-level pricing overrides (deprecated; prefer per-model). Also used by custom providers. */
  pricing?: ProviderPricing;
  /** Legacy provider-level defaultPricing (first model's). Kept for backward compat. */
  defaultPricing?: ProviderPricing;
  /** Additional provider-specific configuration fields shown in the UI */
  advancedFields?: Array<{ key: string; label: string; placeholder: string; type: 'text' | 'password' | 'number'; description: string }>;
  /** User-set values for advanced fields */
  advancedValues?: Record<string, string>;
}

// ─── Custom providers (webview-side) ──────────────────────────────

/** Protocol choices for custom providers. */
export type CustomProviderProtocol = 'openai-compatible' | 'anthropic-compatible' | 'google-compatible';

export interface CustomProviderModel {
  id: string;
  name: string;
  contextLength: number;
  maxOutputTokens: number;
  imageInput: boolean;
  toolCalling: boolean;
  thinking: boolean;
}

export interface CustomProviderConfig {
  id: string;
  label: string;
  protocol: CustomProviderProtocol;
  endpointUrl: string;
  models: CustomProviderModel[];
  defaultPricing?: {
    prompt?: number;
    completion?: number;
    cacheRead?: number;
  };
}

// ─── Host → Webview messages ────────────────────────────────────

export type HostMessage =
  | {
      type: 'initConfig';
      compositeModels: CompositeModelConfig[];
      modelRegistry: ModelRegistrySummary[];
      version: string;
      activeTab?: 'status' | 'config' | 'metrics' | 'providers';
    }
  | { type: 'configSaved' }
  | { type: 'validationError'; errors: string[] }
  | { type: 'configImported'; compositeModels: CompositeModelConfig[] }
  | { type: 'metricsUpdate'; metrics: MetricsPayload }
  | { type: 'statusUpdate'; status: StatusPayload }
  | { type: 'providerConfigSaved'; provider: string }
  | { type: 'initProviderConfig'; providers: ProviderConfigEntry[] }
  | { type: 'metricsQueryResponse'; metric: string; since: string; data: Array<{ windowStart: string; modelId: string; value: number }>; models: string[] }
  | { type: 'initCustomProviders'; customProviders: CustomProviderConfig[] }
  | { type: 'customProviderSaved'; provider: CustomProviderConfig }
  | { type: 'customProviderDeleted'; providerId: string };

// ─── Webview → Host messages ────────────────────────────────────

export type WebviewMessage =
  | { type: 'webviewReady' }
  | { type: 'saveConfig'; compositeModels: CompositeModelConfig[] }
  | { type: 'validateConfig'; compositeModels: CompositeModelConfig[] }
  | { type: 'exportConfig'; compositeModels: CompositeModelConfig[] }
  | { type: 'importConfig' }
  // Whole-router config (provider keys, endpoints, llmLocalRouter.* settings) —
  // distinct from the two above, which only move composite-model definitions.
  | { type: 'exportRouterConfig' }
  | { type: 'importRouterConfig' }
  | { type: 'testModel'; modelId: string }
  | { type: 'saveProvider'; provider: string; apiKey: string; endpointUrl: string; pricing?: ProviderPricing; modelPricing?: Record<string, ProviderPricing>; advancedValues?: Record<string, string> }
  | { type: 'saveCustomProvider'; provider: CustomProviderConfig; apiKey: string }
  | { type: 'deleteCustomProvider'; providerId: string }
  | { type: 'requestCustomProviders' }
  | { type: 'queryMetrics'; metric: string; modelIds: string[]; since: string; until: string };
