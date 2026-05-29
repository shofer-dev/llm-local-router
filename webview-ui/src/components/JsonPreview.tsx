import React from 'react';
import type { CompositeModelConfig } from '../types';

interface Props {
  composite: CompositeModelConfig | null;
}

/**
 * Toggle-able raw JSON preview of the current composite model config.
 */
export default function JsonPreview({ composite }: Props) {
  const [open, setOpen] = React.useState(false);

  if (!composite) return null;

  const json = JSON.stringify(composite, null, 2);

  return (
    <div style={{ marginTop: '4px' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--vscode-textLink-foreground, #3794ff)',
          cursor: 'pointer',
          fontSize: '12px',
          padding: '4px 0',
        }}
      >
        {open ? '▾ Hide JSON' : '▸ Show JSON'}
      </button>
      {open && (
        <pre
          style={{
            background: 'var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1))',
            padding: '10px',
            borderRadius: '2px',
            fontSize: '11px',
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            overflowX: 'auto',
            whiteSpace: 'pre',
            maxHeight: '300px',
            overflowY: 'auto',
          }}
        >
          {json}
        </pre>
      )}
    </div>
  );
}
