import React from 'react';

interface Props {
  /** Validation error messages to display */
  errors?: string[];
  /** Whether a save is in progress */
  saving?: boolean;
  onSave: () => void;
  onExport: () => void;
  onImport: () => void;
  onValidate: () => void;
}

/**
 * Bottom action bar with Save, Import, Export, and Validate buttons.
 */
export default function ActionBar({ errors, saving, onSave, onExport, onImport, onValidate }: Props) {
  return (
    <div>
      {errors && errors.length > 0 && (
        <div
          style={{
            padding: '8px 12px',
            background: 'var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1))',
            borderTop: '1px solid var(--vscode-inputValidation-errorBorder, #be1100)',
            color: 'var(--vscode-inputValidation-errorForeground, #f48771)',
            fontSize: '12px',
          }}
        >
          {errors.map((e, i) => (
            <div key={i}>⚠ {e}</div>
          ))}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 12px',
          borderTop: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
          background: 'var(--vscode-titleBar-activeBackground, rgba(0,0,0,0.1))',
        }}
      >
        <button className="vscode-button" onClick={onSave} disabled={saving}>
          {saving ? 'Saving...' : '💾 Save'}
        </button>

        <div style={{ flex: 1 }} />

        <button className="vscode-button secondary" onClick={onImport}>
          📥 Import
        </button>
        <button className="vscode-button secondary" onClick={onExport}>
          📤 Export
        </button>
        <button className="vscode-button secondary" onClick={onValidate}>
          ✓ Validate
        </button>
      </div>
    </div>
  );
}
