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

// ─── Host → Webview messages ────────────────────────────────────

export type HostMessage =
  | {
      type: 'initConfig';
      compositeModels: CompositeModelConfig[];
      modelRegistry: ModelRegistrySummary[];
    }
  | { type: 'configSaved' }
  | { type: 'validationError'; errors: string[] }
  | { type: 'configImported'; compositeModels: CompositeModelConfig[] };

// ─── Webview → Host messages ────────────────────────────────────

export type WebviewMessage =
  | { type: 'webviewReady' }
  | { type: 'saveConfig'; compositeModels: CompositeModelConfig[] }
  | { type: 'validateConfig'; compositeModels: CompositeModelConfig[] }
  | { type: 'exportConfig'; compositeModels: CompositeModelConfig[] }
  | { type: 'importConfig' }
  | { type: 'testModel'; modelId: string };
