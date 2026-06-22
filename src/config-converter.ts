/**
 * ConfigConverter — pure functions for converting between webview and host
 * composite model config formats, plus validation logic.
 *
 * Extracted from RouterConfigProvider to enable unit testing without
 * requiring the VS Code extension host API.
 */

import type { CompositeModelConfig as HostCompositeConfig } from './types';
import { ALL_MODELS } from './model-registry';

// ─── Webview types (mirrors router-config-provider internal types) ──

export interface WebviewCompositeModel {
  modelId: string;
  strategy: 'failover' | 'round_robin' | 'lowest_latency' | 'highest_reliability';
  streamingTimeoutMs: number;
  nonStreamingTimeoutMs: number;
  totalTimeoutMs: number;
  health?: { failureThreshold: number; degradedThreshold: number; cooldownMs: number };
  throttling?: { maxConcurrent: number; requestsPerWindow: number; windowMinutes: number };
  underlyingModels: Array<{
    modelId: string;
    provider: string;
    weight: number;
    priority: number;
  }>;
  /** For lowest_latency strategy: sliding window in ms for TTFB averaging. */
  latencyWindowMs?: number;
}

// ─── Conversion: webview → host ────────────────────────────────────

/**
 * Convert a webview CompositeModelConfig to the host CompositeModelConfig format.
 * For failover: models are ordered by priority (just model IDs).
 * For round_robin: models include weight objects.
 */
export function convertToHostConfig(wm: WebviewCompositeModel): HostCompositeConfig {
  const models: (string | { id: string; weight?: number })[] = [];

  if (wm.strategy === 'failover') {
    const sorted = [...wm.underlyingModels].sort((a, b) => a.priority - b.priority);
    for (const um of sorted) {
      models.push(um.modelId);
    }
  } else {
    for (const um of wm.underlyingModels) {
      models.push({ id: um.modelId, weight: um.weight || 1 });
    }
  }

  return {
    strategy: wm.strategy,
    models,
    throttling: wm.throttling ? { ...wm.throttling } : undefined,
    streamingTimeoutMs: wm.streamingTimeoutMs,
    perAttemptTimeoutMs: wm.nonStreamingTimeoutMs,
    totalTimeoutMs: wm.totalTimeoutMs,
    latencyWindowMs: wm.latencyWindowMs,
    health: wm.health
      ? {
          failureThreshold: wm.health.failureThreshold,
          degradedThreshold: wm.health.degradedThreshold,
          cooldownMs: wm.health.cooldownMs,
        }
      : undefined,
  };
}

// ─── Conversion: host → webview ────────────────────────────────────

/**
 * Convert host configs (keyed by modelId) back to webview format.
 */
export function convertFromHostConfigs(configs: Record<string, HostCompositeConfig>): WebviewCompositeModel[] {
  const result: WebviewCompositeModel[] = [];

  for (const [modelId, config] of Object.entries(configs)) {
    const underlyingModels: WebviewCompositeModel['underlyingModels'] = [];

    let idx = 0;
    for (const entry of config.models) {
      idx++;
      if (typeof entry === 'string') {
        underlyingModels.push({
          modelId: entry,
          provider: resolveProvider(entry),
          weight: 1,
          priority: idx,
        });
      } else {
        underlyingModels.push({
          modelId: entry.id,
          provider: resolveProvider(entry.id),
          weight: entry.weight ?? 1,
          priority: idx,
        });
      }
    }

    result.push({
      modelId,
      strategy: config.strategy,
      streamingTimeoutMs: config.streamingTimeoutMs ?? 30000,
      nonStreamingTimeoutMs: config.perAttemptTimeoutMs ?? 120000,
      totalTimeoutMs: config.totalTimeoutMs ?? 300000,
      latencyWindowMs: config.latencyWindowMs,
      health: config.health
        ? {
            failureThreshold: config.health.failureThreshold ?? 3,
            degradedThreshold: config.health.degradedThreshold ?? 1,
            cooldownMs: config.health.cooldownMs ?? 30000,
          }
        : undefined,
      throttling: config.throttling,
      underlyingModels,
    });
  }

  return result;
}

// ─── Validation ────────────────────────────────────────────────────

/**
 * Validate an array of webview composite models.
 * Returns an array of error messages (empty = valid).
 */
export function validateCompositeModels(models: WebviewCompositeModel[]): string[] {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const m of models) {
    // Check model ID
    if (!m.modelId) {
      errors.push('A composite model is missing a model_id.');
      continue;
    }
    if (!m.modelId.startsWith('shofer/')) {
      errors.push(`${m.modelId}: model_id must start with "shofer/".`);
    }
    if (seenIds.has(m.modelId)) {
      errors.push(`${m.modelId}: duplicate model_id.`);
    }
    seenIds.add(m.modelId);

    // Check strategy
    const validStrategies = ['failover', 'round_robin', 'lowest_latency', 'highest_reliability'];
    if (!validStrategies.includes(m.strategy)) {
      errors.push(`${m.modelId}: strategy must be "failover", "round_robin", "lowest_latency", or "highest_reliability".`);
    }

    // Check underlying models
    if (m.underlyingModels.length === 0) {
      errors.push(`${m.modelId}: at least one underlying model is required.`);
    }

    const seenUnderlying = new Set<string>();
    for (const um of m.underlyingModels) {
      if (!um.modelId) {
        errors.push(`${m.modelId}: an underlying model is missing model_id.`);
        continue;
      }
      if (seenUnderlying.has(um.modelId)) {
        errors.push(`${m.modelId}: duplicate underlying model "${um.modelId}".`);
      }
      seenUnderlying.add(um.modelId);

      // Check model exists in registry
      const found = findModel(um.modelId);
      if (!found) {
        errors.push(`${m.modelId}: underlying model "${um.modelId}" not found in registry.`);
      }
    }

    // Strategy-specific validation
    if (m.strategy === 'failover') {
      for (const um of m.underlyingModels) {
        if (um.priority && um.priority < 1) {
          errors.push(`${m.modelId}: priority must be >= 1 for failover strategy (model "${um.modelId}").`);
        }
      }
    }
    if (m.strategy === 'round_robin') {
      for (const um of m.underlyingModels) {
        if (um.weight && um.weight < 1) {
          errors.push(`${m.modelId}: weight must be >= 1 for round_robin strategy (model "${um.modelId}").`);
        }
      }
    }

    // Timeouts must be positive — a zero/negative total would make every
    // request fail "Total timeout exceeded" on the first iteration.
    for (const [name, val] of [
      ['streaming_timeout_ms', m.streamingTimeoutMs],
      ['nonstreaming_timeout_ms', m.nonStreamingTimeoutMs],
      ['total_timeout_ms', m.totalTimeoutMs],
    ] as const) {
      if (typeof val === 'number' && val <= 0) {
        errors.push(`${m.modelId}: ${name} must be > 0.`);
      }
    }

    // Check timeouts
    if (m.streamingTimeoutMs > m.totalTimeoutMs) {
      errors.push(
        `${m.modelId}: streaming_timeout_ms (${m.streamingTimeoutMs}) must be <= total_timeout_ms (${m.totalTimeoutMs}).`,
      );
    }
    if (m.nonStreamingTimeoutMs > m.totalTimeoutMs) {
      errors.push(
        `${m.modelId}: nonstreaming_timeout_ms (${m.nonStreamingTimeoutMs}) must be <= total_timeout_ms (${m.totalTimeoutMs}).`,
      );
    }
  }

  return errors;
}

// ─── Helpers ───────────────────────────────────────────────────────

/** Find a registry model by bare id or `provider/id` form. */
function findModel(modelId: string) {
  return ALL_MODELS.find(
    (m) => m.id === modelId || `${m.provider}/${m.id}` === modelId,
  );
}

function resolveProvider(modelId: string): string {
  return findModel(modelId)?.provider ?? '';
}
