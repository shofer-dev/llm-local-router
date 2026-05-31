import React from 'react';
import type { ProviderConfigEntry, ProviderPricing, CustomProviderConfig, CustomProviderModel, CustomProviderProtocol } from '../types';
import { postMessage, onMessage } from '../utils/vscode';

interface Props {
  providers: ProviderConfigEntry[];
}

/**
 * Two-panel provider configuration: left list of built-in + custom providers,
 * right settings editor for the selected entry.
 *
 * Custom (user-registered) primary providers appear below the built-in list
 * and can be added/edited/removed.
 */
export default function ProvidersPanel({ providers }: Props) {
  const [selectedId, setSelectedId] = React.useState<string | null>(
    providers.length > 0 ? providers[0].id : null,
  );
  const [forms, setForms] = React.useState<Record<string, ProviderForm>>({});
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);

  // ─── Custom providers state ─────────────────────────────────────
  const [customProviders, setCustomProviders] = React.useState<CustomProviderConfig[]>([]);
  const [showAddCustom, setShowAddCustom] = React.useState(false);
  const [editingCustomId, setEditingCustomId] = React.useState<string | null>(null);

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
      } else if (msg.type === 'initCustomProviders') {
        setCustomProviders(msg.customProviders);
      } else if (msg.type === 'customProviderSaved') {
        setSaving(false);
        setSaved(true);
        // Refresh custom providers list from host
        // The host will re-send initCustomProviders; we just clear editing state.
        setShowAddCustom(false);
        setEditingCustomId(null);
        setTimeout(() => setSaved(false), 2000);
      } else if (msg.type === 'customProviderDeleted') {
        setSaving(false);
        setSaved(true);
        setShowAddCustom(false);
        setEditingCustomId(null);
        if (selectedId === msg.providerId) {
          setSelectedId(providers.length > 0 ? providers[0].id : null);
        }
        setTimeout(() => setSaved(false), 2000);
      }
    });
    return unsub;
  }, [providers]);

  const isBuiltIn = (id: string) => providers.some(p => p.id === id);
  const selected = providers.find((p) => p.id === selectedId) ?? null;
  const selectedCustom = customProviders.find(cp => cp.id === selectedId) ?? null;
  const form = selectedId ? forms[selectedId] : null;

  const updateForm = (field: string, value: string) => {
    if (!selectedId) return;
    setForms((prev) => ({
      ...prev,
      [selectedId]: { ...prev[selectedId], [field]: value },
    }));
    setSaved(false);
  };

  // ─── Save built-in provider ─────────────────────────────────────

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

  // ─── Save custom provider ───────────────────────────────────────

  const handleSaveCustom = (cfg: CustomProviderConfig) => {
    setSaving(true);
    const formForCustom = forms[cfg.id];
    postMessage({
      type: 'saveCustomProvider',
      provider: cfg,
      apiKey: formForCustom?.apiKey ?? '',
    });
  };

  // ─── Delete custom provider ─────────────────────────────────────

  const handleDeleteCustom = (providerId: string) => {
    if (!confirm(`Delete custom provider "${providerId}" and all its models?`)) return;
    setSaving(true);
    postMessage({ type: 'deleteCustomProvider', providerId });
  };

  // ─── Custom provider form component ─────────────────────────────

  const CustomProviderForm: React.FC<{
    initial?: CustomProviderConfig;
    onSave: (cfg: CustomProviderConfig) => void;
    onCancel: () => void;
    onDelete?: () => void;
  }> = ({ initial, onSave, onCancel, onDelete }) => {
    const [id, setId] = React.useState(initial?.id ?? '');
    const [label, setLabel] = React.useState(initial?.label ?? '');
    const [protocol, setProtocol] = React.useState<CustomProviderProtocol>(initial?.protocol ?? 'openai-compatible');
    const [endpointUrl, setEndpointUrl] = React.useState(initial?.endpointUrl ?? '');
    const [apiKey, setApiKey] = React.useState('');
    const [promptPrice, setPromptPrice] = React.useState(initial?.defaultPricing?.prompt?.toString() ?? '');
    const [completionPrice, setCompletionPrice] = React.useState(initial?.defaultPricing?.completion?.toString() ?? '');
    const [cacheReadPrice, setCacheReadPrice] = React.useState(initial?.defaultPricing?.cacheRead?.toString() ?? '');
    // Models editor (simple JSON textarea)
    const [modelsJson, setModelsJson] = React.useState(
      initial ? JSON.stringify(initial.models, null, 2) : '[\n  {"id": "model-id", "name": "Model Name", "contextLength": 131072, "maxOutputTokens": 16384, "imageInput": false, "toolCalling": true}\n]'
    );
    const [jsonError, setJsonError] = React.useState('');

    const handleSubmit = () => {
      if (!id.trim() || !label.trim() || !endpointUrl.trim()) return;
      let models: CustomProviderModel[];
      try {
        models = JSON.parse(modelsJson);
        if (!Array.isArray(models) || models.length === 0) {
          setJsonError('Models must be a non-empty array.');
          return;
        }
      } catch {
        setJsonError('Invalid JSON format.');
        return;
      }
      setJsonError('');

      const cfg: CustomProviderConfig = {
        id: id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
        label: label.trim(),
        protocol,
        endpointUrl: endpointUrl.trim(),
        models,
        defaultPricing: promptPrice || completionPrice || cacheReadPrice
          ? {
              prompt: promptPrice ? parseFloat(promptPrice) : undefined,
              completion: completionPrice ? parseFloat(completionPrice) : undefined,
              cacheRead: cacheReadPrice ? parseFloat(cacheReadPrice) : undefined,
            }
          : undefined,
      };

      // Also push API key into the forms state so handleSaveCustom can find it
      setForms(prev => ({
        ...prev,
        [cfg.id]: { apiKey, endpointUrl: cfg.endpointUrl, promptPrice, completionPrice, cacheReadPrice },
      }));

      onSave(cfg);
    };

    return (
      <div style={{ padding: '12px', overflowY: 'auto' }}>
        <div style={{ marginBottom: '12px' }}>
          <label style={styles.fieldLabel}>Provider ID</label>
          <input
            type="text"
            className="vscode-input"
            style={{ width: '100%' }}
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="my-custom-provider"
            disabled={!!initial}
          />
          <div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground, #999)', marginTop: '2px' }}>
            Unique ID (lowercase, a-z, 0-9, -, _). Cannot be changed after creation.
          </div>
        </div>

        <div style={{ marginBottom: '12px' }}>
          <label style={styles.fieldLabel}>Label</label>
          <input
            type="text"
            className="vscode-input"
            style={{ width: '100%' }}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="My Provider"
          />
        </div>

        <div style={{ marginBottom: '12px' }}>
          <label style={styles.fieldLabel}>Protocol</label>
          <select
            className="vscode-input"
            style={{ width: '100%' }}
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as CustomProviderProtocol)}
          >
            <option value="openai-compatible">OpenAI Compatible</option>
            <option value="anthropic-compatible">Anthropic Compatible</option>
            <option value="google-compatible">Google Compatible</option>
          </select>
          <div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground, #999)', marginTop: '2px' }}>
            Determines how requests are formatted before sending to the provider.
          </div>
        </div>

        <div style={{ marginBottom: '12px' }}>
          <label style={styles.fieldLabel}>API Key</label>
          <input
            type="password"
            className="vscode-input"
            style={{ width: '100%' }}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={initial ? '(stored — enter to change)' : 'sk-...'}
          />
        </div>

        <div style={{ marginBottom: '12px' }}>
          <label style={styles.fieldLabel}>Endpoint URL</label>
          <input
            type="text"
            className="vscode-input"
            style={{ width: '100%' }}
            value={endpointUrl}
            onChange={(e) => setEndpointUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </div>

        <div style={{ marginBottom: '12px' }}>
          <label style={{ ...styles.fieldLabel, marginBottom: '6px' }}>
            Default Pricing (USD per 1M tokens)
          </label>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 120px' }}>
              <label style={styles.subLabel}>Prompt ($/1M)</label>
              <input
                type="number"
                className="vscode-input"
                style={{ width: '100%' }}
                value={promptPrice}
                onChange={(e) => setPromptPrice(e.target.value)}
                placeholder="—"
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
                value={completionPrice}
                onChange={(e) => setCompletionPrice(e.target.value)}
                placeholder="—"
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
                value={cacheReadPrice}
                onChange={(e) => setCacheReadPrice(e.target.value)}
                placeholder="—"
                step="0.01"
                min="0"
              />
            </div>
          </div>
        </div>

        <div style={{ marginBottom: '12px' }}>
          <label style={styles.fieldLabel}>
            Models
            {jsonError && <span style={{ color: 'var(--vscode-errorForeground, #f48771)', marginLeft: '8px', fontWeight: 400, textTransform: 'none' }}>{jsonError}</span>}
          </label>
          <textarea
            className="vscode-input"
            style={{ width: '100%', minHeight: '150px', fontFamily: 'monospace', fontSize: '12px' }}
            value={modelsJson}
            onChange={(e) => { setModelsJson(e.target.value); setJsonError(''); }}
          />
          <div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground, #999)', marginTop: '2px' }}>
            JSON array of model objects. Each model needs: id, name, contextLength, maxOutputTokens, imageInput, toolCalling.
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
          <button className="vscode-button" onClick={handleSubmit} disabled={saving}>
            {saving ? 'Saving...' : saved ? '✓ Saved' : '💾 Save Custom Provider'}
          </button>
          <button className="vscode-button" onClick={onCancel} style={{ background: 'var(--vscode-button-secondaryBackground)' }}>
            Cancel
          </button>
          {onDelete && (
            <button className="vscode-button" onClick={onDelete} style={{ background: 'var(--vscode-inputValidation-errorBackground, #5a1d1d)', marginLeft: 'auto' }}>
              🗑 Delete
            </button>
          )}
        </div>
      </div>
    );
  };

  // ─── Determine what to show in the right panel ──────────────────

  const renderRightPanel = () => {
    // Adding a new custom provider
    if (showAddCustom) {
      return (
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 12px',
            borderBottom: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
            background: 'var(--vscode-titleBar-activeBackground, rgba(0,0,0,0.1))',
            flexShrink: 0,
          }}>
            <span style={{ fontSize: '13px', fontWeight: 600 }}>New Custom Provider</span>
          </div>
          <CustomProviderForm
            onSave={handleSaveCustom}
            onCancel={() => setShowAddCustom(false)}
          />
        </div>
      );
    }

    // Editing an existing custom provider
    if (editingCustomId && selectedCustom) {
      return (
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 12px',
            borderBottom: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
            background: 'var(--vscode-titleBar-activeBackground, rgba(0,0,0,0.1))',
            flexShrink: 0,
          }}>
            <span style={{ fontSize: '13px', fontWeight: 600 }}>Edit: {selectedCustom.label}</span>
          </div>
          <CustomProviderForm
            initial={selectedCustom}
            onSave={handleSaveCustom}
            onCancel={() => setEditingCustomId(null)}
            onDelete={() => handleDeleteCustom(selectedCustom.id)}
          />
        </div>
      );
    }

    // Built-in provider editing (existing flow)
    if (selected && form && isBuiltIn(selected.id)) {
      return (
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
        </div>
      );
    }

    // Nothing selected
    return (
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
    );
  };

  // ─── Main layout ────────────────────────────────────────────────

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
        {/* Built-in providers header */}
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
              onClick={() => { setSelectedId(p.id); setShowAddCustom(false); setEditingCustomId(null); }}
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

        {/* Custom providers section */}
        <div style={{
          padding: '8px 12px',
          borderTop: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
          borderBottom: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
          fontSize: '11px',
          fontWeight: 600,
          textTransform: 'uppercase',
          color: 'var(--vscode-descriptionForeground, #999)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>Custom Providers</span>
          <button
            className="vscode-button"
            style={{ fontSize: '10px', padding: '1px 6px', lineHeight: '16px' }}
            onClick={() => { setSelectedId(null); setShowAddCustom(true); setEditingCustomId(null); }}
          >
            + Add
          </button>
        </div>

        {customProviders.length === 0 ? (
          <div style={{ padding: '12px', fontSize: '11px', color: 'var(--vscode-descriptionForeground, #999)', textAlign: 'center' }}>
            No custom providers registered. Click "+ Add" to register one.
          </div>
        ) : (
          customProviders.map((cp) => {
            const isSelected = cp.id === selectedId;
            const cpForm = forms[cp.id];
            const hasKey = !!cpForm?.apiKey || false; // apiKey in form means user entered one
            return (
              <div
                key={cp.id}
                onClick={() => { setSelectedId(cp.id); setShowAddCustom(false); setEditingCustomId(cp.id); }}
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
                    {cp.label}
                    <span style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground, #999)', marginLeft: '4px' }}>
                      ({cp.protocol})
                    </span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #999)', marginTop: '2px' }}>
                    {cp.models.length} model{cp.models.length !== 1 ? 's' : ''}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Right panel */}
      {renderRightPanel()}
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
};
