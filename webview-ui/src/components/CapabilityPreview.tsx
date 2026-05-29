import React from 'react';
import type { CompositeModelConfig, ModelRegistrySummary } from '../types';

interface Props {
  composite: CompositeModelConfig | null;
  modelRegistry: ModelRegistrySummary[];
}

/**
 * Computes and displays the capability intersection of a composite model's
 * underlying models — i.e., what capabilities are available when routing
 * through this composite.
 */
export default function CapabilityPreview({ composite, modelRegistry }: Props) {
  if (!composite || composite.underlyingModels.length === 0) return null;

  const registryMap = new Map(modelRegistry.map((m) => [m.id, m]));

  let minInput = Infinity;
  let minOutput = Infinity;
  let imageInput = true;
  let toolCalling = true;
  let promptCache = true;
  let found = false;

  for (const um of composite.underlyingModels) {
    const m = registryMap.get(um.modelId);
    if (!m) continue;
    found = true;
    minInput = Math.min(minInput, m.maxInputTokens);
    minOutput = Math.min(minOutput, m.maxOutputTokens);
    imageInput = imageInput && m.imageInput;
    toolCalling = toolCalling && m.toolCalling;
    promptCache = promptCache && m.promptCache;
  }

  if (!found) {
    return (
      <div style={{ padding: '8px', fontSize: '11px', color: 'var(--vscode-descriptionForeground, #999)' }}>
        ⚠ Some underlying models are not found in the registry.
      </div>
    );
  }

  return (
    <div
      style={{
        padding: '8px',
        border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
        borderRadius: '2px',
        marginBottom: '12px',
        fontSize: '12px',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: '4px', fontSize: '11px', textTransform: 'uppercase', color: 'var(--vscode-descriptionForeground, #999)' }}>
        Capability Intersection
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
        <CapBadge label="Input" value={`${minInput.toLocaleString()} tokens`} />
        <CapBadge label="Output" value={`${minOutput.toLocaleString()} tokens`} />
        <CapBadge label="Image" value={imageInput ? '✓' : '✗'} ok={imageInput} />
        <CapBadge label="Tools" value={toolCalling ? '✓' : '✗'} ok={toolCalling} />
        <CapBadge label="Cache" value={promptCache ? '✓' : '✗'} ok={promptCache} />
      </div>
    </div>
  );
}

function CapBadge({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  const color = ok === false ? 'var(--vscode-errorForeground, #f48771)' : ok === true ? 'var(--vscode-testing-iconPassed, #73c991)' : undefined;
  return (
    <span
      className="vscode-badge"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
        color,
      }}
    >
      {label}: {value}
    </span>
  );
}
