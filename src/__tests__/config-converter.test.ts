/**
 * Unit tests for config-converter — pure functions for type conversion
 * and validation of composite model configurations.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  convertToHostConfig,
  convertFromHostConfigs,
  validateCompositeModels,
  type WebviewCompositeModel,
} from '../config-converter';
import type { CompositeModelConfig as HostCompositeConfig } from '../types';

// ─── Test data ──────────────────────────────────────────────────────

const WEBVIEW_FAILOVER: WebviewCompositeModel = {
  modelId: 'shofer/code',
  strategy: 'failover',
  streamingTimeoutMs: 30000,
  nonStreamingTimeoutMs: 120000,
  totalTimeoutMs: 300000,
  underlyingModels: [
    { modelId: 'deepseek-v4-pro', provider: 'deepseek', weight: 1, priority: 1 },
    { modelId: 'claude-sonnet-4-6', provider: 'anthropic', weight: 1, priority: 2 },
  ],
};

const WEBVIEW_ROUND_ROBIN: WebviewCompositeModel = {
  modelId: 'shofer/balanced',
  strategy: 'round_robin',
  streamingTimeoutMs: 45000,
  nonStreamingTimeoutMs: 90000,
  totalTimeoutMs: 180000,
  underlyingModels: [
    { modelId: 'deepseek-v4-pro', provider: 'deepseek', weight: 3, priority: 1 },
    { modelId: 'claude-sonnet-4-6', provider: 'anthropic', weight: 1, priority: 2 },
  ],
  throttling: { maxConcurrent: 25, requestsPerWindow: 200, windowMinutes: 10 },
  health: { failureThreshold: 5, degradedThreshold: 2, cooldownMs: 60000 },
};

// ─── convertToHostConfig ────────────────────────────────────────────

describe('convertToHostConfig', () => {
  it('converts failover strategy — models become ordered strings', () => {
    const result = convertToHostConfig(WEBVIEW_FAILOVER);
    assert.equal(result.strategy, 'failover');
    assert.deepStrictEqual(result.models, ['deepseek-v4-pro', 'claude-sonnet-4-6']);
  });

  it('converts round_robin strategy — models become weight objects', () => {
    const result = convertToHostConfig(WEBVIEW_ROUND_ROBIN);
    assert.equal(result.strategy, 'round_robin');
    assert.deepStrictEqual(result.models, [
      { id: 'deepseek-v4-pro', weight: 3 },
      { id: 'claude-sonnet-4-6', weight: 1 },
    ]);
  });

  it('maps streamingTimeoutMs → streamingTimeoutMs', () => {
    const result = convertToHostConfig(WEBVIEW_FAILOVER);
    assert.equal(result.streamingTimeoutMs, 30000);
  });

  it('maps nonStreamingTimeoutMs → perAttemptTimeoutMs', () => {
    const result = convertToHostConfig(WEBVIEW_FAILOVER);
    assert.equal(result.perAttemptTimeoutMs, 120000);
  });

  it('maps totalTimeoutMs → totalTimeoutMs', () => {
    const result = convertToHostConfig(WEBVIEW_FAILOVER);
    assert.equal(result.totalTimeoutMs, 300000);
  });

  it('preserves throttling config when present', () => {
    const result = convertToHostConfig(WEBVIEW_ROUND_ROBIN);
    assert.deepStrictEqual(result.throttling, {
      maxConcurrent: 25,
      requestsPerWindow: 200,
      windowMinutes: 10,
    });
  });

  it('returns undefined throttling when absent', () => {
    const result = convertToHostConfig(WEBVIEW_FAILOVER);
    assert.equal(result.throttling, undefined);
  });

  it('preserves health config when present', () => {
    const result = convertToHostConfig(WEBVIEW_ROUND_ROBIN);
    assert.deepStrictEqual(result.health, {
      failureThreshold: 5,
      degradedThreshold: 2,
      cooldownMs: 60000,
    });
  });

  it('returns undefined health when absent', () => {
    const result = convertToHostConfig(WEBVIEW_FAILOVER);
    assert.equal(result.health, undefined);
  });

  it('sorts models by priority for failover strategy', () => {
    const outOfOrder: WebviewCompositeModel = {
      ...WEBVIEW_FAILOVER,
      underlyingModels: [
        { modelId: 'model-b', provider: 'deepseek', weight: 1, priority: 3 },
        { modelId: 'model-a', provider: 'deepseek', weight: 1, priority: 1 },
        { modelId: 'model-c', provider: 'deepseek', weight: 1, priority: 2 },
      ],
    };
    const result = convertToHostConfig(outOfOrder);
    assert.deepStrictEqual(result.models, ['model-a', 'model-c', 'model-b']);
  });

  it('defaults weight to 1 for round_robin models with weight 0', () => {
    const zeroWeight: WebviewCompositeModel = {
      ...WEBVIEW_ROUND_ROBIN,
      underlyingModels: [
        { modelId: 'deepseek-v4-pro', provider: 'deepseek', weight: 0, priority: 1 },
      ],
    };
    const result = convertToHostConfig(zeroWeight);
    const first = result.models[0] as { id: string; weight: number };
    assert.equal(first.weight, 1);
  });
});

// ─── convertFromHostConfigs ─────────────────────────────────────────

describe('convertFromHostConfigs', () => {
  it('converts host configs back to webview format', () => {
    const hostConfigs: Record<string, HostCompositeConfig> = {
      'shofer/code': {
        strategy: 'failover',
        models: ['deepseek-v4-pro', 'claude-sonnet-4-6'],
        streamingTimeoutMs: 30000,
        perAttemptTimeoutMs: 120000,
        totalTimeoutMs: 300000,
      },
    };

    const result = convertFromHostConfigs(hostConfigs);
    assert.equal(result.length, 1);
    assert.equal(result[0].modelId, 'shofer/code');
    assert.equal(result[0].strategy, 'failover');
    assert.equal(result[0].streamingTimeoutMs, 30000);
    assert.equal(result[0].nonStreamingTimeoutMs, 120000);
    assert.equal(result[0].totalTimeoutMs, 300000);
    assert.equal(result[0].underlyingModels.length, 2);
    assert.equal(result[0].underlyingModels[0].modelId, 'deepseek-v4-pro');
    assert.equal(result[0].underlyingModels[0].provider, 'deepseek');
    assert.equal(result[0].underlyingModels[0].priority, 1);
    assert.equal(result[0].underlyingModels[1].modelId, 'claude-sonnet-4-6');
    assert.equal(result[0].underlyingModels[1].provider, 'anthropic');
    assert.equal(result[0].underlyingModels[1].priority, 2);
  });

  it('converts weight objects for round_robin', () => {
    const hostConfigs: Record<string, HostCompositeConfig> = {
      'shofer/balanced': {
        strategy: 'round_robin',
        models: [
          { id: 'deepseek-v4-pro', weight: 3 },
          { id: 'claude-sonnet-4-6', weight: 1 },
        ],
      },
    };

    const result = convertFromHostConfigs(hostConfigs);
    assert.equal(result[0].underlyingModels[0].weight, 3);
    assert.equal(result[0].underlyingModels[1].weight, 1);
  });

  it('applies defaults for missing timeout fields', () => {
    const hostConfigs: Record<string, HostCompositeConfig> = {
      'shofer/minimal': {
        strategy: 'failover',
        models: ['deepseek-v4-pro'],
      },
    };

    const result = convertFromHostConfigs(hostConfigs);
    assert.equal(result[0].streamingTimeoutMs, 30000);
    assert.equal(result[0].nonStreamingTimeoutMs, 120000);
    assert.equal(result[0].totalTimeoutMs, 300000);
  });
});

// ─── validateCompositeModels ────────────────────────────────────────

describe('validateCompositeModels', () => {
  it('returns empty array for valid failover config', () => {
    const errors = validateCompositeModels([WEBVIEW_FAILOVER]);
    assert.deepStrictEqual(errors, []);
  });

  it('returns empty array for valid round_robin config', () => {
    const errors = validateCompositeModels([WEBVIEW_ROUND_ROBIN]);
    assert.deepStrictEqual(errors, []);
  });

  it('reports missing model_id', () => {
    const models: WebviewCompositeModel[] = [
      { ...WEBVIEW_FAILOVER, modelId: '' },
    ];
    const errors = validateCompositeModels(models);
    assert.ok(errors.some((e) => e.includes('missing a model_id')));
  });

  it('reports model_id not starting with shofer/', () => {
    const models: WebviewCompositeModel[] = [
      { ...WEBVIEW_FAILOVER, modelId: 'my-model' },
    ];
    const errors = validateCompositeModels(models);
    assert.ok(errors.some((e) => e.includes('must start with "shofer/"')));
  });

  it('reports duplicate model_id across composites', () => {
    const errors = validateCompositeModels([WEBVIEW_FAILOVER, WEBVIEW_FAILOVER]);
    assert.ok(errors.some((e) => e.includes('duplicate model_id')));
  });

  it('reports invalid strategy', () => {
    const models: WebviewCompositeModel[] = [
      { ...WEBVIEW_FAILOVER, strategy: 'random' as any },
    ];
    const errors = validateCompositeModels(models);
    assert.ok(errors.some((e) => e.includes('strategy must be')));
  });

  it('reports zero underlying models', () => {
    const models: WebviewCompositeModel[] = [
      { ...WEBVIEW_FAILOVER, underlyingModels: [] },
    ];
    const errors = validateCompositeModels(models);
    assert.ok(errors.some((e) => e.includes('at least one underlying model')));
  });

  it('reports missing underlying model_id', () => {
    const models: WebviewCompositeModel[] = [
      {
        ...WEBVIEW_FAILOVER,
        underlyingModels: [
          { modelId: '', provider: '', weight: 1, priority: 1 },
        ],
      },
    ];
    const errors = validateCompositeModels(models);
    assert.ok(errors.some((e) => e.includes('missing model_id')));
  });

  it('reports duplicate underlying model_ids', () => {
    const models: WebviewCompositeModel[] = [
      {
        ...WEBVIEW_FAILOVER,
        underlyingModels: [
          { modelId: 'deepseek-v4-pro', provider: 'deepseek', weight: 1, priority: 1 },
          { modelId: 'deepseek-v4-pro', provider: 'deepseek', weight: 1, priority: 2 },
        ],
      },
    ];
    const errors = validateCompositeModels(models);
    assert.ok(errors.some((e) => e.includes('duplicate underlying model')));
  });

  it('reports model not found in registry', () => {
    const models: WebviewCompositeModel[] = [
      {
        ...WEBVIEW_FAILOVER,
        underlyingModels: [
          { modelId: 'nonexistent-model', provider: 'openai', weight: 1, priority: 1 },
        ],
      },
    ];
    const errors = validateCompositeModels(models);
    assert.ok(errors.some((e) => e.includes('not found in registry')));
  });

  it('reports streaming timeout > total timeout', () => {
    const models: WebviewCompositeModel[] = [
      { ...WEBVIEW_FAILOVER, streamingTimeoutMs: 400000, totalTimeoutMs: 300000 },
    ];
    const errors = validateCompositeModels(models);
    assert.ok(errors.some((e) => e.includes('streaming_timeout_ms')));
  });

  it('reports nonstreaming timeout > total timeout', () => {
    const models: WebviewCompositeModel[] = [
      { ...WEBVIEW_FAILOVER, nonStreamingTimeoutMs: 400000, totalTimeoutMs: 300000 },
    ];
    const errors = validateCompositeModels(models);
    assert.ok(errors.some((e) => e.includes('nonstreaming_timeout_ms')));
  });

  it('validates multiple models', () => {
    const errors = validateCompositeModels([WEBVIEW_FAILOVER, WEBVIEW_ROUND_ROBIN]);
    assert.deepStrictEqual(errors, []);
  });
});

// ─── Round-trip conversion ──────────────────────────────────────────

describe('round-trip conversion', () => {
  it('failover: webview → host → webview preserves data', () => {
    const host = convertToHostConfig(WEBVIEW_FAILOVER);
    const hostConfigs: Record<string, HostCompositeConfig> = {
      [WEBVIEW_FAILOVER.modelId]: host,
    };
    const roundTripped = convertFromHostConfigs(hostConfigs);
    assert.equal(roundTripped.length, 1);
    assert.equal(roundTripped[0].modelId, WEBVIEW_FAILOVER.modelId);
    assert.equal(roundTripped[0].strategy, WEBVIEW_FAILOVER.strategy);
    assert.equal(roundTripped[0].streamingTimeoutMs, WEBVIEW_FAILOVER.streamingTimeoutMs);
    assert.equal(roundTripped[0].nonStreamingTimeoutMs, WEBVIEW_FAILOVER.nonStreamingTimeoutMs);
    assert.equal(roundTripped[0].totalTimeoutMs, WEBVIEW_FAILOVER.totalTimeoutMs);
    assert.equal(roundTripped[0].underlyingModels.length, WEBVIEW_FAILOVER.underlyingModels.length);
    for (let i = 0; i < WEBVIEW_FAILOVER.underlyingModels.length; i++) {
      assert.equal(roundTripped[0].underlyingModels[i].modelId, WEBVIEW_FAILOVER.underlyingModels[i].modelId);
    }
  });

  it('round_robin: webview → host → webview preserves data', () => {
    const host = convertToHostConfig(WEBVIEW_ROUND_ROBIN);
    const hostConfigs: Record<string, HostCompositeConfig> = {
      [WEBVIEW_ROUND_ROBIN.modelId]: host,
    };
    const roundTripped = convertFromHostConfigs(hostConfigs);
    assert.equal(roundTripped.length, 1);
    assert.equal(roundTripped[0].strategy, 'round_robin');
    assert.equal(roundTripped[0].underlyingModels[0].weight, 3);
    assert.equal(roundTripped[0].underlyingModels[1].weight, 1);
  });
});
