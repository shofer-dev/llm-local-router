import React from 'react';
import type { ProviderConfigEntry } from '../types';
import { postMessage, onMessage } from '../utils/vscode';

interface Props {
  providers: ProviderConfigEntry[];
}

/**
 * Providers panel for configuring API keys and endpoint URLs per provider.
 *
 * Each provider card shows:
 *  - Provider name and model count
 *  - API key input (password field, shows placeholder when key exists)
 *  - Endpoint URL input (pre-filled with default)
 *  - Save button
 */
export default function ProvidersPanel({ providers }: Props) {
  // Local state: per-provider form fields
  const [forms, setForms] = React.useState<Record<string, { apiKey: string; endpointUrl: string }>>({});
  const [saving, setSaving] = React.useState<Record<string, boolean>>({});
  const [saved, setSaved] = React.useState<Record<string, boolean>>({});

  // Initialize forms from provider config
  React.useEffect(() => {
    const init: Record<string, { apiKey: string; endpointUrl: string }> = {};
    for (const p of providers) {
      init[p.id] = { apiKey: '', endpointUrl: p.endpointUrl };
    }
    setForms(init);
  }, [providers]);

  // Listen for save confirmation
  React.useEffect(() => {
    const unsub = onMessage((msg) => {
      if (msg.type === 'providerConfigSaved') {
        setSaving((prev) => ({ ...prev, [msg.provider]: false }));
        setSaved((prev) => ({ ...prev, [msg.provider]: true }));
        // Also clear the API key field since it was saved
        setForms((prev) => ({
          ...prev,
          [msg.provider]: { ...prev[msg.provider], apiKey: '' },
        }));
        setTimeout(() => {
          setSaved((prev) => ({ ...prev, [msg.provider]: false }));
        }, 2000);
      }
    });
    return unsub;
  }, []);

  const handleSave = (providerId: string) => {
    const form = forms[providerId];
    if (!form) return;
    setSaving((prev) => ({ ...prev, [providerId]: true }));
    setSaved((prev) => ({ ...prev, [providerId]: false }));
    postMessage({
      type: 'saveProvider',
      provider: providerId,
      apiKey: form.apiKey,
      endpointUrl: form.endpointUrl,
    });
  };

  const updateForm = (providerId: string, field: 'apiKey' | 'endpointUrl', value: string) => {
    setForms((prev) => ({
      ...prev,
      [providerId]: { ...prev[providerId], [field]: value },
    }));
    setSaved((prev) => ({ ...prev, [providerId]: false }));
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
      <h2 style={styles.title}>Provider API Keys & Endpoints</h2>
      <p style={styles.subtitle}>
        Enter API keys for the providers you want to use. Keys are stored securely
        via the VS Code Secret Storage API (OS keychain).
        You can also override the default API endpoint URL for each provider.
      </p>

      <div style={styles.grid}>
        {providers.map((p) => {
          const form = forms[p.id] || { apiKey: '', endpointUrl: p.endpointUrl };
          const isSaving = saving[p.id];
          const isSaved = saved[p.id];

          return (
            <div key={p.id} style={styles.card}>
              <div style={styles.cardHeader}>
                <span style={styles.providerName}>{p.label}</span>
                <span style={styles.modelCount}>
                  {p.modelCount} model{p.modelCount !== 1 ? 's' : ''}
                </span>
                {p.hasApiKey && !form.apiKey && (
                  <span style={styles.configuredBadge}>● Configured</span>
                )}
              </div>

              <label style={styles.fieldLabel}>
                API Key
                <input
                  type="password"
                  style={styles.input}
                  value={form.apiKey}
                  onChange={(e) => updateForm(p.id, 'apiKey', e.target.value)}
                  placeholder={p.hasApiKey ? '(stored — enter new key to change)' : 'sk-...'}
                />
              </label>

              <label style={styles.fieldLabel}>
                Endpoint URL
                <input
                  type="text"
                  style={styles.input}
                  value={form.endpointUrl}
                  onChange={(e) => updateForm(p.id, 'endpointUrl', e.target.value)}
                  placeholder={p.defaultEndpoint}
                />
              </label>

              <div style={styles.cardActions}>
                <button
                  className="vscode-button"
                  style={styles.saveButton}
                  onClick={() => handleSave(p.id)}
                  disabled={isSaving}
                >
                  {isSaving ? 'Saving...' : isSaved ? '✓ Saved' : 'Save'}
                </button>
                {form.endpointUrl !== p.defaultEndpoint && (
                  <button
                    className="vscode-button"
                    style={styles.resetButton}
                    onClick={() => updateForm(p.id, 'endpointUrl', p.defaultEndpoint)}
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
          );
        })}
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
  title: {
    margin: '0 0 4px',
    fontSize: '16px',
    fontWeight: 600,
  },
  subtitle: {
    margin: '0 0 16px',
    fontSize: '12px',
    color: 'var(--vscode-descriptionForeground, #999)',
    lineHeight: 1.5,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: '12px',
  },
  card: {
    border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
    borderRadius: '6px',
    padding: '12px',
    background: 'var(--vscode-editor-background)',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '4px',
  },
  providerName: {
    fontWeight: 600,
    fontSize: '13px',
    flex: 1,
  },
  modelCount: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground, #999)',
  },
  configuredBadge: {
    fontSize: '10px',
    color: 'var(--vscode-testing-iconPassed, #73c991)',
    fontWeight: 600,
  },
  fieldLabel: {
    fontSize: '11px',
    fontWeight: 500,
    color: 'var(--vscode-descriptionForeground, #999)',
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
  },
  input: {
    padding: '4px 8px',
    fontSize: '12px',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    color: 'var(--vscode-input-foreground)',
    backgroundColor: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: '3px',
    outline: 'none',
  },
  cardActions: {
    display: 'flex',
    gap: '6px',
    marginTop: '4px',
  },
  saveButton: {
    flex: 1,
    padding: '4px 12px',
    fontSize: '12px',
  },
  resetButton: {
    padding: '4px 8px',
    fontSize: '11px',
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
