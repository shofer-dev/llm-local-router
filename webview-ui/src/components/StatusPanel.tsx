import React from 'react';
import type { StatusPayload } from '../types';

interface Props {
  status: StatusPayload | null;
}

/**
 * Status panel showing connection info and available models with search.
 *
 * Renders:
 *  - Status summary (enabled, connected, configured providers, model count)
 *  - Search bar for filtering models by name, ID, or provider
 *  - Available models table with token limits, capabilities, and pricing
 */
export default function StatusPanel({ status }: Props) {
  const [search, setSearch] = React.useState('');

  if (!status) {
    return (
      <div style={styles.empty}>
        <p style={styles.emptyIcon}>🔌</p>
        <p>Waiting for connection status...</p>
      </div>
    );
  }

  const configuredCount = status.providers.filter((p) => p.configured).length;
  const totalProviderCount = status.providers.length;

  const filteredModels = search.trim()
    ? status.models.filter((m) => {
        const q = search.toLowerCase();
        return (
          m.name.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q)
        );
      })
    : status.models;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>Router Status</h2>
        <ConnectionBadge connected={status.connected} enabled={status.enabled} />
      </div>

      {/* Status summary */}
      <h3 style={styles.sectionTitle}>Status</h3>
      <div style={styles.statusGrid}>
        <StatusCard
          label="Enabled"
          value={status.enabled ? 'Yes' : 'No'}
          icon={status.enabled ? '✅' : '⏸'}
        />
        <StatusCard
          label="Connection"
          value={status.connected ? 'Connected' : 'Disconnected'}
          icon={status.connected ? '✅' : '⚠️'}
        />
        <StatusCard
          label="Providers"
          value={`${configuredCount} of ${totalProviderCount} configured`}
          icon={configuredCount > 0 ? '🔑' : '🔒'}
        />
        <StatusCard
          label="Models"
          value={`${status.models.length} available`}
          icon="📦"
        />
      </div>

      {/* Available models with search */}
      <h3 style={styles.sectionTitle}>
        Available Models
        <span style={styles.modelCount}>
          {filteredModels.length}{search.trim() && filteredModels.length !== status.models.length ? ` of ${status.models.length}` : ''} total
        </span>
      </h3>

      <input
        type="text"
        placeholder="Search by name, ID, or provider..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={styles.searchInput}
      />

      {filteredModels.length === 0 ? (
        <div style={styles.noResults}>
          {search.trim() ? 'No models match your search.' : 'No models available.'}
        </div>
      ) : (
        <div style={styles.tableWrapper}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Model</th>
                <th style={styles.th}>ID</th>
                <th style={styles.th}>Provider</th>
                <th style={styles.th}>Input Tokens</th>
                <th style={styles.th}>Output Tokens</th>
                <th style={styles.th}>Capabilities</th>
                <th style={styles.th}>Pricing (per 1M)</th>
              </tr>
            </thead>
            <tbody>
              {filteredModels.map((m) => (
                <tr key={m.id} style={m.isComposite ? styles.compositeRow : undefined}>
                  <td style={styles.td}>
                    <span style={styles.modelName}>{m.name}</span>
                    {m.isComposite && <span style={styles.compositeTag}>composite</span>}
                  </td>
                  <td style={styles.td}>
                    <code style={styles.mono}>{m.id}</code>
                  </td>
                  <td style={styles.td}>
                    <span style={styles.providerTag}>{m.provider}</span>
                  </td>
                  <td style={styles.td}>{m.maxInputTokens.toLocaleString()}</td>
                  <td style={styles.td}>{m.maxOutputTokens.toLocaleString()}</td>
                  <td style={styles.td}>
                    <div style={styles.caps}>
                      {m.toolCalling && <CapBadge label="tools" />}
                      {m.imageInput && <CapBadge label="image" />}
                      {m.promptCache && <CapBadge label="cache" />}
                    </div>
                  </td>
                  <td style={styles.td}>
                    {m.pricing ? (
                      <span style={styles.mono}>
                        ${m.pricing.inputPrice}/ ${m.pricing.outputPrice}
                      </span>
                    ) : (
                      <span style={styles.na}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────

function ConnectionBadge({ connected, enabled }: { connected: boolean; enabled: boolean }) {
  let label: string;
  let color: string;
  let icon: string;

  if (!enabled) {
    label = 'Disabled';
    color = 'var(--vscode-descriptionForeground, #999)';
    icon = '⏸';
  } else if (connected) {
    label = 'Connected';
    color = 'var(--vscode-testing-iconPassed, #73c991)';
    icon = '✅';
  } else {
    label = 'Disconnected';
    color = 'var(--vscode-testing-iconFailed, #f14c4c)';
    icon = '⚠️';
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '2px 10px',
        borderRadius: '10px',
        fontSize: '11px',
        fontWeight: 600,
        color,
        border: `1px solid ${color}`,
      }}
    >
      {icon} {label}
    </span>
  );
}

interface StatusCardProps {
  label: string;
  value: string;
  icon: string;
}

function StatusCard({ label, value, icon }: StatusCardProps) {
  return (
    <div style={{
      padding: '10px 12px',
      border: '1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2))',
      borderRadius: '4px',
      background: 'var(--vscode-editor-background)',
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ fontSize: '13px' }}>{icon}</span>
        <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #999)', fontWeight: 500 }}>
          {label}
        </span>
      </div>
      <span style={{ fontWeight: 600, fontSize: '13px' }}>{value}</span>
    </div>
  );
}

function CapBadge({ label }: { label: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 5px',
        borderRadius: '3px',
        fontSize: '10px',
        fontWeight: 500,
        background: 'var(--vscode-badge-background, rgba(128,128,128,0.2))',
        color: 'var(--vscode-badge-foreground, #ccc)',
        marginRight: '3px',
      }}
    >
      {label}
    </span>
  );
}

// ─── Styles ─────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '16px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: '12px',
    color: 'var(--vscode-foreground)',
    maxWidth: '100%',
    overflowX: 'auto',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px',
  },
  title: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 600,
  },
  sectionTitle: {
    fontSize: '13px',
    fontWeight: 600,
    marginTop: '20px',
    marginBottom: '8px',
    display: 'flex',
    alignItems: 'baseline',
    gap: '8px',
  },
  modelCount: {
    fontSize: '11px',
    fontWeight: 400,
    color: 'var(--vscode-descriptionForeground, #999)',
  },
  statusGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: '8px',
  },
  searchInput: {
    width: '100%',
    padding: '6px 10px',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    color: 'var(--vscode-input-foreground)',
    backgroundColor: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: '3px',
    marginBottom: '8px',
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  tableWrapper: {
    overflowX: 'auto',
    marginBottom: '4px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '11px',
  },
  th: {
    textAlign: 'left' as const,
    padding: '4px 8px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    fontWeight: 600,
    whiteSpace: 'nowrap' as const,
    color: 'var(--vscode-descriptionForeground)',
  },
  td: {
    padding: '3px 8px',
    borderBottom: '1px solid var(--vscode-panel-border, #333)',
    verticalAlign: 'top' as const,
  },
  compositeRow: {
    backgroundColor: 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.03))',
  },
  modelName: {
    fontWeight: 600,
    display: 'block',
  },
  mono: {
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '11px',
  },
  providerTag: {
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
  },
  compositeTag: {
    fontSize: '9px',
    backgroundColor: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
    padding: '1px 4px',
    borderRadius: '3px',
    marginLeft: '4px',
  },
  caps: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '2px',
  },
  na: {
    color: 'var(--vscode-descriptionForeground, #999)',
  },
  noResults: {
    padding: '20px',
    textAlign: 'center' as const,
    color: 'var(--vscode-descriptionForeground, #999)',
    fontSize: '12px',
  },
  empty: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    color: 'var(--vscode-descriptionForeground)',
    textAlign: 'center' as const,
  },
  emptyIcon: {
    fontSize: '32px',
    margin: 0,
  },
};
