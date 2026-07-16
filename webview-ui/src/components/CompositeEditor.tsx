import React from 'react';
import StrategySelector from './StrategySelector';
import ModelList from './ModelList';
import ConfigSection from './ConfigSection';
import NumberInput from './NumberInput';
import CapabilityPreview from './CapabilityPreview';
import type { CompositeModelConfig, ModelRegistrySummary, UnderlyingModelEntry } from '../types';

interface Props {
  composite: CompositeModelConfig | null;
  modelRegistry: ModelRegistrySummary[];
  onChange: (updated: CompositeModelConfig) => void;
}

const DEFAULT_HEALTH = { failureThreshold: 3, degradedThreshold: 1, cooldownMs: 30000 };
const DEFAULT_THROTTLING = { maxConcurrent: 50, requestsPerWindow: 100, windowMinutes: 5 };

/**
 * Right panel: edit the selected composite model's configuration.
 */
export default function CompositeEditor({ composite, modelRegistry, onChange }: Props) {
  if (!composite) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--vscode-descriptionForeground, #999)',
          fontSize: '13px',
        }}
      >
        Select a composite model from the list, or create a new one.
      </div>
    );
  }

  const health = composite.health ?? DEFAULT_HEALTH;
  const throttling = composite.throttling ?? DEFAULT_THROTTLING;

  const update = (patch: Partial<CompositeModelConfig>) => {
    onChange({ ...composite, ...patch });
  };

  const updateHealth = (patch: Partial<typeof health>) => {
    update({ health: { ...health, ...patch } });
  };

  const updateThrottling = (patch: Partial<typeof throttling>) => {
    update({ throttling: { ...throttling, ...patch } });
  };

  const updateModels = (models: UnderlyingModelEntry[]) => {
    update({ underlyingModels: models });
  };

  return (
    <div style={{ padding: '12px', overflowY: 'auto', height: '100%' }}>
      {/* Model ID */}
      <div style={{ marginBottom: '12px' }}>
        <label style={{ display: 'block', marginBottom: '4px', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', color: 'var(--vscode-descriptionForeground, #999)' }}>
          Model ID
        </label>
        <input
          type="text"
          className="vscode-input"
          value={composite.modelId}
          onChange={(e) => update({ modelId: e.target.value })}
          placeholder="local/my-composite"
          style={{ width: '100%' }}
        />
      </div>

      {/* Strategy */}
      <StrategySelector
        value={composite.strategy}
        onChange={(strategy) => {
          // Reset weight/priority when strategy changes
          const models = composite.underlyingModels.map((m, i) => ({
            ...m,
            weight: strategy === 'round_robin' ? (m.weight || 1) : m.weight,
            priority: strategy === 'failover' ? i + 1 : m.priority,
          }));
          update({ strategy, underlyingModels: models });
        }}
      />

      {/* Underlying models (with dnd) */}
      <ModelList
        models={composite.underlyingModels}
        strategy={composite.strategy}
        modelRegistry={modelRegistry}
        onChange={updateModels}
      />

      {/* Live capability intersection — updates as models are added/removed */}
      <CapabilityPreview composite={composite} modelRegistry={modelRegistry} />

      {/* Throttling */}
      <ConfigSection title="Throttling">
        <NumberInput
          label="Max Concurrent"
          value={throttling.maxConcurrent}
          min={1}
          max={1000}
          onChange={(v) => updateThrottling({ maxConcurrent: v })}
        />
        <NumberInput
          label="Requests Per Window"
          value={throttling.requestsPerWindow}
          min={1}
          max={100000}
          onChange={(v) => updateThrottling({ requestsPerWindow: v })}
        />
        <NumberInput
          label="Window Minutes"
          value={throttling.windowMinutes}
          min={1}
          max={1440}
          onChange={(v) => updateThrottling({ windowMinutes: v })}
        />
      </ConfigSection>

      {/* Timeouts */}
      <ConfigSection title="Timeouts">
        <NumberInput
          label="Streaming Timeout (ms)"
          value={composite.streamingTimeoutMs}
          min={1000}
          max={600000}
          step={1000}
          onChange={(v) => update({ streamingTimeoutMs: v })}
        />
        <NumberInput
          label="Non-Streaming Timeout (ms)"
          value={composite.nonStreamingTimeoutMs}
          min={1000}
          max={600000}
          step={1000}
          onChange={(v) => update({ nonStreamingTimeoutMs: v })}
        />
        <NumberInput
          label="Total Timeout (ms)"
          value={composite.totalTimeoutMs}
          min={1000}
          max={600000}
          step={1000}
          onChange={(v) => update({ totalTimeoutMs: v })}
        />
      </ConfigSection>

      {/* Sliding window (lowest_latency averages TTFB / highest_reliability
          averages success ratio over this window) */}
      {(composite.strategy === 'lowest_latency' || composite.strategy === 'highest_reliability') && (
        <ConfigSection title={composite.strategy === 'lowest_latency' ? 'Latency' : 'Reliability'}>
          <NumberInput
            label="Sliding Window (ms)"
            value={composite.latencyWindowMs ?? 600000}
            min={30000}
            max={3600000}
            step={30000}
            onChange={(v) => update({ latencyWindowMs: v })}
          />
        </ConfigSection>
      )}

      {/* Health */}
      <ConfigSection title="Health">
        <NumberInput
          label="Failure Threshold"
          value={health.failureThreshold}
          min={1}
          max={100}
          onChange={(v) => updateHealth({ failureThreshold: v })}
        />
        <NumberInput
          label="Degraded Threshold"
          value={health.degradedThreshold}
          min={1}
          max={100}
          onChange={(v) => updateHealth({ degradedThreshold: v })}
        />
        <NumberInput
          label="Cooldown (ms)"
          value={health.cooldownMs}
          min={0}
          max={600000}
          step={1000}
          onChange={(v) => updateHealth({ cooldownMs: v })}
        />
      </ConfigSection>
    </div>
  );
}
