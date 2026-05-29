import React from 'react';
import type { ProviderConfigEntry } from '../types';
import { postMessage, onMessage } from '../utils/vscode';

interface Props {
  providers: ProviderConfigEntry[];
}

/**
 * Providers panel for configuring API keys and endpoint URLs per provider.
 * Compact table layout with a single "Save All" button.
 */
export default function ProvidersPanel({ providers }: Props) {
  type FormState = Record<string, { apiKey: string; endpointUrl: string }>;

  const [forms, setForms] = React.useState<FormState>({});
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Initialize forms from provider config
  React.useEffect(() => {
    const init: FormState = {};
    for (const p of providers) {
      init[p.id] = { apiKey: '', endpointUrl: p.endpointUrl };
    }
    setForms(init);
  }, [providers]);

  // Listen for save confirmation
  React.useEffect(() => {
    const unsub = onMessage((msg) => {
      if (msg.type === 'providerConfigSaved') {
        setSaving(false);
        setSaved(true);
        // Clear API key fields since they were saved
        setForms((prev) => ({
          ...prev,
          [msg.provider]: { ...prev[msg.provider], apiKey: '' },
        }));
        setTimeout(() => setSaved(false), 2000);
      }
    });
    return unsub;
  }, []);

  const updateForm = (provId: string, field: 'apiKey' | 'endpointUrl', value: string) => {
    setForms((prev) => ({
      ...prev,
      [provId]: { ...prev[provId], [field]: value },
    }));
    setSaved(false);
    setError(null);
  };

  const handleSaveAll = async () => {
    // Collect all providers that have changed
    const changed: Array<{ provider: string; apiKey: string; endpointUrl: string }> = [];
    for (const p of providers) {
      const form = forms[p.id];
      if (!form) continue;
      const hasApiKey = form.apiKey.trim() !== '';
      const hasEndpointChange = form.endpointUrl !== p.endpointUrl;
      if (hasApiKey || hasEndpointChange) {
        changed.push({ provider: p.id, apiKey: form.apiKey, endpointUrl: form.endpointUrl });
      }
    }

    if (changed.length === 0) {
      setError('No changes to save.');
      return;
    }

    setSaving(true);
    setError(null);

    // Save sequentially
    for (const c of changed) {
      postMessage({
        type: 'saveProvider',
        provider: c.provider,
        apiKey: c.apiKey,
        endpointUrl: c.endpointUrl,
      });
      // Small delay between messages to avoid flooding
      await new Promise((r) => setTimeout(r, 50));
    }
    // The last providerConfigSaved message will set saving=false
  };

  if (providers.length === 0) {
    return (
      <div style={styles.empty}>
        <p style={styles.emptyIcon}>🔑</p>
        <p>No provider configuration available.</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>Provider API Keys & Endpoints</h2>
          <p style={styles.subtitle}>
            Keys are stored securely via the VS Code Secret Storage API (OS keychain).
          </p>
        </div>
        <div style={styles.headerActions}>
          {error && <span style={styles.errorText}>{error}</span>}
          <button
            className="vscode-button"
            onClick={handleSaveAll}
            disabled={saving}
            style={styles.saveAllButton}
          >
            {saving ? 'Saving...' : saved ? '✓ Saved' : '💾 Save All'}
          </button>
        </div>
      </div>

      <div style={styles.tableWrapper}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Provider</th>
              <th style={styles.th}>API Key</th>
              <th style={styles.th}>Endpoint URL</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => {
              const form = forms[p.id] || { apiKey: '', endpointUrl: p.endpointUrl };
              const hasCustomEndpoint = form.endpointUrl !== p.defaultEndpoint;

              return (
                <tr key={p.id}>
                  <td style={styles.td}>
                    <div style={styles.providerCell}>
                      <span style={styles.providerName}>{p.label}</span>
                      {p.hasApiKey && !form.apiKey && (
                        <span style={styles.configuredBadge}>●</span>
                      )}
                      <span style={styles.modelCount}>
                        {p.modelCount} model{p.modelCount !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </td>
                  <td style={styles.td}>
                    <input
                      type="password"
                      style={styles.input}
                      value={form.apiKey}
                      onChange={(e) => updateForm(p.id, 'apiKey', e.target.value)}
                      placeholder={p.hasApiKey ? '(stored)' : 'sk-...'}
                    />
                  </td>
                  <td style={styles.td}>
                    <div style={styles.endpointCell}>
                      <input
                        type="text"
                        style={{
                          ...styles.input,
                          borderColor: hasCustomEndpoint
                            ? 'var(--vscode-focusBorder, #007acc)'
                            : undefined,
                        }}
                        value={form.endpointUrl}
                        onChange={(e) => updateForm(p.id, 'endpointUrl', e.target.value)}
                        placeholder={p.defaultEndpoint}
                      />
                      {hasCustomEndpoint && (
                        <button
                          style={styles.resetBtn}
                          onClick={() => updateForm(p.id, 'endpointUrl', p.defaultEndpoint)}
                          title="Reset to default"
                        >
                          ↺
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '16px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: '12px',
    color: 'var(--vscode-foreground)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '12px',
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexShrink: 0,
    marginTop: '2px',
  },
  title: {
    margin: '0 0 2px',
    fontSize: '16px',
    fontWeight: 600,
  },
  subtitle: {
    margin: 0,
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground, #999)',
  },
  saveAllButton: {
    padding: '6px 16px',
    fontSize: '12px',
    fontWeight: 600,
  },
  errorText: {
    fontSize: '11px',
    color: 'var(--vscode-inputValidation-errorForeground, #f48771)',
  },
  tableWrapper: {
    overflowX: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '12px',
  },
  th: {
    textAlign: 'left' as const,
    padding: '6px 8px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    fontWeight: 600,
    whiteSpace: 'nowrap' as const,
    color: 'var(--vscode-descriptionForeground)',
    fontSize: '11px',
  },
  td: {
    padding: '4px 8px',
    borderBottom: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.15))',
    verticalAlign: 'middle' as const,
  },
  providerCell: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    whiteSpace: 'nowrap' as const,
  },
  providerName: {
    fontWeight: 600,
    fontSize: '13px',
  },
  configuredBadge: {
    color: 'var(--vscode-testing-iconPassed, #73c991)',
    fontSize: '10px',
  },
  modelCount: {
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground, #999)',
  },
  input: {
    width: '100%',
    padding: '3px 6px',
    fontSize: '12px',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    color: 'var(--vscode-input-foreground)',
    backgroundColor: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: '3px',
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  endpointCell: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  resetBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--vscode-descriptionForeground, #999)',
    cursor: 'pointer',
    fontSize: '14px',
    padding: '0 2px',
    flexShrink: 0,
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    color: 'var(--vscode-descriptionForeground)',
    textAlign: 'center',
  },
  emptyIcon: {
    fontSize: '32px',
    margin: 0,
  },
};
