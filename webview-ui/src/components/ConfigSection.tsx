import React from 'react';

interface Props {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

/**
 * A collapsible section with a title header. Used to group related
 * configuration fields (Throttling, Timeouts, Health).
 */
export default function ConfigSection({ title, defaultOpen = true, children }: Props) {
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <div style={{ marginBottom: '16px' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          width: '100%',
          padding: '6px 8px',
          background: 'var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.1))',
          border: 'none',
          color: 'var(--vscode-editor-foreground)',
          cursor: 'pointer',
          fontSize: '13px',
          fontWeight: 600,
          textAlign: 'left',
        }}
      >
        <span style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', fontSize: '10px' }}>
          ▶
        </span>
        {title}
      </button>
      {open && (
        <div style={{ padding: '8px', border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))', borderTop: 'none' }}>
          {children}
        </div>
      )}
    </div>
  );
}
