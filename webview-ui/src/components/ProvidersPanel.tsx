import React from 'react';
import type { ProviderConfigEntry, ProviderPricing } from '../types';
import { postMessage, onMessage } from '../utils/vscode';

interface Props {
  providers: ProviderConfigEntry[];
}

/**
 * Two-panel provider configuration: left list of providers, right settings editor.
 * Same layout pattern as ConfigEditor (Composite Models).
 */
export default function ProvidersPanel({ providers }: Props) {
  const [selectedId, setSelectedId] = React.useState<string | null>(
    providers.length > 0 ? providers[0].id : null,
  );
  const [forms, setForms] = React.useState<Record<string, ProviderForm>>({});
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);

  type ProviderForm = {
    apiKey: string;
    endpointUrl: string;
    promptPrice: string;
    completionPrice: string;
    cacheReadPrice: string;
  };

  // Initialize forms from provider config
  React.useEffect(() => {
    const init: Record<string, ProviderForm> = {};
    for (const p of providers) {
      init[p.id] = {
        apiKey: '',
        endpointUrl: p.endpointUrl,
        promptPrice: p.pricing?.prompt?.toString() ?? '',
        completionPrice: p.pricing?.completion?.toString() ?? '',
        cacheReadPrice: p.pricing?.cacheRead?.toString() ?? '',
      };
    }
    setForms(init);
  }, [providers]);

  React.useEffect(() => {
    const unsub = onMessage((msg) => {
      if (msg.type === 'providerConfigSaved') {
        setSaving(false);
        setSaved(true);
        setForms((prev) => ({
          ...prev,
          [msg.provider]: { ...prev[msg.provider], apiKey: '' },
        }));
        setTimeout(() => setSaved(false), 2000);
      }
    });
    return unsub;
  }, []);

  const selected = providers.find((p) => p.id === selectedId) ?? null;
  const form = selectedId ? forms[selectedId] : null;

  const updateForm = (field: string, value: string) => {
    if (!selectedId) return;
    setForms((prev) => ({
      ...prev,
      [selectedId]: { ...prev[selectedId], [field]: value },
    }));
    setSaved(false);
  };

  const handleSave = () => {
    if (!selectedId || !form) return;
    setSaving(true);

    const pricing: ProviderPricing | undefined =
      form.promptPrice || form.completionPrice || form.cacheReadPrice
        ? {
            prompt: form.promptPrice ? parseFloat(form.promptPrice) : undefined,
            completion: form.completionPrice ? parseFloat(form.completionPrice) : undefined,
            cacheRead: form.cacheReadPrice ? parseFloat(form.cacheReadPrice) : undefined,
          }
        : undefined;

    postMessage({
      type: 'saveProvider',
      provider: selectedId,
      apiKey: form.apiKey,
      endpointUrl: form.endpointUrl,
      pricing,
    });
  };

  if (providers.length === 0) {
    return (
      <div style={styles.empty}>
        <p style={styles.emptyIcon}>🔑</p>
        <p>No providers available. Add API keys in the Settings tab.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Left panel: provider list */}
      <div style={{
        width: '260px',
        minWidth: '200px',
        borderRight: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
        overflowY: 'auto',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
          fontSize: '11px',
          fontWeight: 600,
          textTransform: 'uppercase',
          color: 'var(--vscode-descriptionForeground, #999)',
        }}>
          Providers
        </div>

        {providers.map((p) => {
          const isSelected = p.id === selectedId;
          return (
            <div
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 12px',
                cursor: 'pointer',
                background: isSelected ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent',
                borderBottom: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.1))',
              }}
            >
              <div style={{ overflow: 'hidden' }}>
                <div style={{ fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.label}
                  {p.hasApiKey && (
                    <span style={{ color: 'var(--vscode-testing-iconPassed, #73c991)', marginLeft: '6px', fontSize: '10px' }}>●</span>
                  )}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #999)', marginTop: '2px' }}>
                  {p.modelCount} model{p.modelCount !== 1 ? 's' : ''}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Right panel: provider settings editor */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {/* Save button at top */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 12px',
          borderBottom: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
          background: 'var(--vscode-titleBar-activeBackground, rgba(0,0,0,0.1))',
          flexShrink: 0,
        }}>
          <button className="vscode-button" onClick={handleSave} disabled={saving || !selected}>
            {saving ? 'Saving...' : saved ? '✓ Saved' : '💾 Save'}
          </button>
        </div>

        {/* Settings form */}
        {selected && form ? (
          <div style={{ padding: '12px', overflowY: 'auto' }}>
            {/* API Key */}
            <div style={{ marginBottom: '12px' }}>
              <label style={styles.fieldLabel}>API Key</label>
              <input
                type="password"
                className="vscode-input"
                style={{ width: '100%' }}
                value={form.apiKey}
                onChange={(e) => updateForm('apiKey', e.target.value)}
                placeholder={selected.hasApiKey ? '(stored — enter to change)' : 'sk-...'}
              />
            </div>

            {/* Endpoint URL */}
            <div style={{ marginBottom: '12px' }}>
              <label style={styles.fieldLabel}>Endpoint URL</label>
              <div style={{ display: 'flex', gap: '4px' }}>
                <input
                  type="text"
                  className="vscode-input"
                  style={{ flex: 1 }}
                  value={form.endpointUrl}
                  onChange={(e) => updateForm('endpointUrl', e.target.value)}
                  placeholder={selected.defaultEndpoint}
                />
                {form.endpointUrl !== selected.defaultEndpoint && (
                  <button
                    className="vscode-button"
                    style={{ fontSize: '11px', padding: '2px 6px' }}
                    onClick={() => updateForm('endpointUrl', selected.defaultEndpoint)}
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>

            {/* Pricing overrides */}
            <div style={{ marginBottom: '12px' }}>
              <label style={{ ...styles.fieldLabel, marginBottom: '6px' }}>
                Pricing Overrides (USD per 1M tokens)
              </label>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 120px' }}>
                  <label style={styles.subLabel}>Prompt ($/1M)</label>
                  <input
                    type="number"
                    className="vscode-input"
                    style={{ width: '100%' }}
                    value={form.promptPrice}
                    onChange={(e) => updateForm('promptPrice', e.target.value)}
                    placeholder={selected.defaultPricing?.prompt?.toString() ?? '—'}
                    step="0.01"
                    min="0"
                  />
                </div>
                <div style={{ flex: '1 1 120px' }}>
                  <label style={styles.subLabel}>Completion ($/1M)</label>
                  <input
                    type="number"
                    className="vscode-input"
                    style={{ width: '100%' }}
                    value={form.completionPrice}
                    onChange={(e) => updateForm('completionPrice', e.target.value)}
                    placeholder={selected.defaultPricing?.completion?.toString() ?? '—'}
                    step="0.01"
                    min="0"
                  />
                </div>
                <div style={{ flex: '1 1 120px' }}>
                  <label style={styles.subLabel}>Cache Read ($/1M)</label>
                  <input
                    type="number"
                    className="vscode-input"
                    style={{ width: '100%' }}
                    value={form.cacheReadPrice}
                    onChange={(e) => updateForm('cacheReadPrice', e.target.value)}
                    placeholder={selected.defaultPricing?.cacheRead?.toString() ?? '—'}
                    step="0.01"
                    min="0"
                  />
                </div>
              </div>
              <div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground, #999)', marginTop: '4px' }}>
                Leave blank to use default pricing from the model registry.
              </div>
            </div>

            {/* Provider models info */}
            <div style={{
              padding: '8px',
              border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
              borderRadius: '2px',
              fontSize: '11px',
              color: 'var(--vscode-descriptionForeground, #999)',
            }}>
              <strong>{selected.label}</strong> — {selected.modelCount} model{selected.modelCount !== 1 ? 's' : ''} available.
              Keys are stored via VS Code SecretStorage (OS keychain).
            </div>
          </div>
        ) : (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--vscode-descriptionForeground, #999)',
            fontSize: '13px',
          }}>
            Select a provider from the list.
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  fieldLabel: {
    display: 'block',
    marginBottom: '4px',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    color: 'var(--vscode-descriptionForeground, #999)',
  },
  subLabel: {
    display: 'block',
    marginBottom: '2px',
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground, #999)',
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: 'var(--vscode-descriptionForeground)',
    textAlign: 'center',
  },
  emptyIcon: {
    fontSize: '32px',
    margin: 0,
  },
};
