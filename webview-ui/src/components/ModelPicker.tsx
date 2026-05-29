import React from 'react';
import type { ModelRegistrySummary } from '../types';

interface Props {
  models: ModelRegistrySummary[];
  value: string;
  onChange: (modelId: string, provider: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * Dropdown populated from the model registry, showing model ID,
 * provider badge, and token limits.
 */
export default function ModelPicker({ models, value, onChange, disabled, placeholder }: Props) {
  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const modelId = e.target.value;
    const found = models.find((m) => m.id === modelId);
    onChange(modelId, found?.provider ?? '');
  };

  return (
    <select
      className="vscode-select"
      value={value}
      disabled={disabled}
      onChange={handleChange}
      style={{ width: '100%', minWidth: '200px' }}
    >
      <option value="">{placeholder ?? '— Select a model —'}</option>
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name} ({m.provider}) — {m.maxInputTokens.toLocaleString()} in / {m.maxOutputTokens.toLocaleString()} out
        </option>
      ))}
    </select>
  );
}
