import React from 'react';

interface Props {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

/**
 * A bounded numeric input with label, styled consistently with VS Code.
 */
export default function NumberInput({
  label,
  value,
  min,
  max,
  step = 1,
  disabled = false,
  onChange,
}: Props) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = parseInt(e.target.value, 10);
    if (isNaN(raw)) return;
    let clamped = raw;
    if (min !== undefined && clamped < min) clamped = min;
    if (max !== undefined && clamped > max) clamped = max;
    onChange(clamped);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
      <label style={{ flex: '0 0 auto', minWidth: '160px', fontSize: '12px', color: 'var(--vscode-descriptionForeground, #999)' }}>
        {label}
      </label>
      <input
        type="number"
        className="vscode-input"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={handleChange}
        style={{ width: '100px' }}
      />
    </div>
  );
}
