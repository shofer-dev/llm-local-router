/**
 * Webview-specific types for the Shofer LLM Router configuration UI.
 *
 * These mirror the host-side types from ../src/types.ts but are
 * self-contained for the webview build (which does not have access
 * to the extension host's node_modules or vscode API).
 */

// ─── Strategy ───────────────────────────────────────────────────

export type RoutingStrategy = 'failover' | 'round_robin';

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

// ─── Host → Webview messages ────────────────────────────────────

export type HostMessage =
  | {
      type: 'initConfig';
      compositeModels: CompositeModelConfig[];
      modelRegistry: ModelRegistrySummary[];
      activeTab?: 'status' | 'config' | 'metrics';
    }
  | { type: 'configSaved' }
  | { type: 'validationError'; errors: string[] }
  | { type: 'configImported'; compositeModels: CompositeModelConfig[] }
  | { type: 'metricsUpdate'; metrics: MetricsPayload }
  | { type: 'statusUpdate'; status: StatusPayload };

// ─── Webview → Host messages ────────────────────────────────────

export type WebviewMessage =
  | { type: 'webviewReady' }
  | { type: 'saveConfig'; compositeModels: CompositeModelConfig[] }
  | { type: 'validateConfig'; compositeModels: CompositeModelConfig[] }
  | { type: 'exportConfig'; compositeModels: CompositeModelConfig[] }
  | { type: 'importConfig' }
  | { type: 'testModel'; modelId: string };
