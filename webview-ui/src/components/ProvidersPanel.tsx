import React from 'react';
import type { ProviderConfigEntry, ProviderPricing, CustomProviderConfig, CustomProviderModel, CustomProviderProtocol } from '../types';
import { postMessage, onMessage } from '../utils/vscode';

// ─── Props ────────────────────────────────────────────────────────

interface Props {
  providers: ProviderConfigEntry[];
}

interface CustomProviderFormProps {
  initial?: CustomProviderConfig;
  saving: boolean;
  saved: boolean;
  onSave: (cfg: CustomProviderConfig, apiKey: string) => void;
  onCancel: () => void;
  onDelete?: () => void;
  /** Callback so the form can stash the API key before parent saves. */
  onFormChange: (cfgId: string, form: { apiKey: string; endpointUrl: string; promptPrice: string; completionPrice: string; cacheReadPrice: string }) => void;
}

// ─── Custom provider form (module scope — stable identity) ────────

/**
 * Standalone form for adding/editing a custom primary provider.
 * Defined at module scope so React preserves component identity across
 * parent re-renders (e.g., when metricsUpdate fires every 15s).
 */
const CustomProviderForm: React.FC<CustomProviderFormProps> = ({ initial, saving, saved, onSave, onCancel, onDelete, onFormChange }) => {
  const [id, setId] = React.useState(initial?.id ?? '');
  const [protocol, setProtocol] = React.useState<CustomProviderProtocol>(initial?.protocol ?? 'openai-compatible');
  const [endpointUrl, setEndpointUrl] = React.useState(initial?.endpointUrl ?? '');
  const [apiKey, setApiKey] = React.useState('');
  const [promptPrice, setPromptPrice] = React.useState(initial?.defaultPricing?.prompt?.toString() ?? '');
  const [completionPrice, setCompletionPrice] = React.useState(initial?.defaultPricing?.completion?.toString() ?? '');
  const [cacheReadPrice, setCacheReadPrice] = React.useState(initial?.defaultPricing?.cacheRead?.toString() ?? '');

  // Single model fields
  const firstModel = initial?.models?.[0];
  const [modelId, setModelId] = React.useState(firstModel?.id ?? '');
  const [contextLength, setContextLength] = React.useState(firstModel?.contextLength?.toString() ?? '131072');
  const [maxOutputTokens, setMaxOutputTokens] = React.useState(firstModel?.maxOutputTokens?.toString() ?? '16384');
  const [imageInput, setImageInput] = React.useState(firstModel?.imageInput ?? false);
  const [toolCalling, setToolCalling] = React.useState(firstModel?.toolCalling ?? true);
  const [thinking, setThinking] = React.useState(firstModel?.thinking ?? false);
  const [modelError, setModelError] = React.useState('');

  const handleSubmit = () => {
    if (!id.trim() || !endpointUrl.trim()) return;
    if (!modelId.trim()) {
      setModelError('Model ID is required.');
      return;
    }
    setModelError('');

    const model: CustomProviderModel = {
      id: modelId.trim(),
      name: modelId.trim(),
      contextLength: parseInt(contextLength, 10) || 131072,
      maxOutputTokens: parseInt(maxOutputTokens, 10) || 16384,
      imageInput,
      toolCalling,
      thinking,
    };

    const cfg: CustomProviderConfig = {
      id: id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
      label: id.trim(),
      protocol,
      endpointUrl: endpointUrl.trim(),
      models: [model],
      defaultPricing: promptPrice || completionPrice || cacheReadPrice
        ? {
            prompt: promptPrice ? parseFloat(promptPrice) : undefined,
            completion: completionPrice ? parseFloat(completionPrice) : undefined,
            cacheRead: cacheReadPrice ? parseFloat(cacheReadPrice) : undefined,
          }
        : undefined,
    };

    onSave(cfg, apiKey);
  };

  return (
    <div style={{ padding: '12px', overflowY: 'auto' }}>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
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

      <div style={{ marginBottom: '12px' }}>
        <label style={formStyles.fieldLabel}>Provider ID</label>
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
        <label style={formStyles.fieldLabel}>Protocol</label>
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
        <label style={formStyles.fieldLabel}>API Key</label>
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
        <label style={formStyles.fieldLabel}>Endpoint URL</label>
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
        <label style={{ ...formStyles.fieldLabel, marginBottom: '6px' }}>
          Default Pricing (USD per 1M tokens)
        </label>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 120px' }}>
            <label style={formStyles.subLabel}>Prompt ($/1M)</label>
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
            <label style={formStyles.subLabel}>Completion ($/1M)</label>
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
            <label style={formStyles.subLabel}>Cache Read ($/1M)</label>
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
        <label style={{ ...formStyles.fieldLabel, marginBottom: '6px' }}>
          Model
          {modelError && <span style={{ color: 'var(--vscode-errorForeground, #f48771)', marginLeft: '8px', fontWeight: 400, textTransform: 'none' }}>{modelError}</span>}
        </label>

        <div style={{ marginBottom: '8px' }}>
          <label style={formStyles.subLabel}>Model ID</label>
          <input
            type="text"
            className="vscode-input"
            style={{ width: '100%' }}
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            placeholder="my-model-v1"
          />
        </div>

        <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
          <div style={{ flex: '1 1 120px' }}>
            <label style={formStyles.subLabel}>Context Length</label>
            <input
              type="number"
              className="vscode-input"
              style={{ width: '100%' }}
              value={contextLength}
              onChange={(e) => setContextLength(e.target.value)}
              placeholder="131072"
              step="1"
              min="1"
            />
          </div>
          <div style={{ flex: '1 1 120px' }}>
            <label style={formStyles.subLabel}>Max Output Tokens</label>
            <input
              type="number"
              className="vscode-input"
              style={{ width: '100%' }}
              value={maxOutputTokens}
              onChange={(e) => setMaxOutputTokens(e.target.value)}
              placeholder="16384"
              step="1"
              min="1"
            />
          </div>
        </div>

        <label style={{ ...formStyles.subLabel, marginBottom: '4px' }}>Capabilities</label>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '4px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={imageInput}
              onChange={(e) => setImageInput(e.target.checked)}
            />
            Image Input
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={toolCalling}
              onChange={(e) => setToolCalling(e.target.checked)}
            />
            Tool Calling
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={thinking}
              onChange={(e) => setThinking(e.target.checked)}
            />
            Thinking
          </label>
        </div>
      </div>

    </div>
  );
};

// ─── Main panel ───────────────────────────────────────────────────

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

  // Request custom providers when this component mounts
  // (the initCustomProviders message may have been sent before this
  // component was rendered — it only mounts when the user navigates to
  // Config → Primary Providers).
  React.useEffect(() => {
    postMessage({ type: 'requestCustomProviders' });
  }, []);

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
        console.log('[customProvider:webview] initCustomProviders received:', msg.customProviders);
        setCustomProviders(msg.customProviders);
      } else if (msg.type === 'customProviderSaved') {
        setSaving(false);
        setSaved(true);
        setShowAddCustom(false);
        // Keep the edit form open after save, transitioning from "add" to "edit" mode
        setEditingCustomId(msg.provider.id);
        // Update the custom providers list so the new/edited provider appears
        setCustomProviders((prev) => {
          const idx = prev.findIndex((cp) => cp.id === msg.provider.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = msg.provider;
            return next;
          }
          return [...prev, msg.provider];
        });
        // Select the newly saved provider in the left panel
        setSelectedId(msg.provider.id);
        setTimeout(() => setSaved(false), 2000);
      } else if (msg.type === 'customProviderDeleted') {
        setSaving(false);
        setSaved(true);
        setShowAddCustom(false);
        setEditingCustomId(null);
        // Remove the deleted provider from the custom providers list
        setCustomProviders((prev) => prev.filter((cp) => cp.id !== msg.providerId));
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

  // ─── Save / delete custom provider ──────────────────────────────

  const handleSaveCustom = (cfg: CustomProviderConfig, apiKey: string) => {
    setSaving(true);
    postMessage({
      type: 'saveCustomProvider',
      provider: cfg,
      apiKey,
    });
  };

  const handleDeleteCustom = (providerId: string) => {
    // Confirmation is handled host-side via vscode.window.showWarningMessage:
    // the browser `window.confirm()` is a no-op inside VS Code webviews, which
    // previously made the Delete button appear unresponsive. We intentionally
    // do not flip `saving` here — if the user cancels the host-side modal no
    // reply is sent, so flipping it would leave the Save button stuck disabled.
    postMessage({ type: 'deleteCustomProvider', providerId });
  };

  /** Called by CustomProviderForm to stash its form fields before save. */
  const handleCustomFormChange = (
    cfgId: string,
    f: { apiKey: string; endpointUrl: string; promptPrice: string; completionPrice: string; cacheReadPrice: string }
  ) => {
    setForms(prev => ({ ...prev, [cfgId]: f }));
  };

  // ─── Determine what to show in the right panel ──────────────────

  const renderRightPanel = () => {
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
            key="new"
            saving={saving}
            saved={saved}
            onSave={handleSaveCustom}
            onCancel={() => setShowAddCustom(false)}
            onFormChange={handleCustomFormChange}
          />
        </div>
      );
    }

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
            key={selectedCustom.id}
            initial={selectedCustom}
            saving={saving}
            saved={saved}
            onSave={handleSaveCustom}
            onCancel={() => setEditingCustomId(null)}
            onDelete={() => handleDeleteCustom(selectedCustom.id)}
            onFormChange={handleCustomFormChange}
          />
        </div>
      );
    }

    if (selected && form && isBuiltIn(selected.id)) {
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
            <button className="vscode-button" onClick={handleSave} disabled={saving || !selected}>
              {saving ? 'Saving...' : saved ? '✓ Saved' : '💾 Save'}
            </button>
          </div>

          <div style={{ padding: '12px', overflowY: 'auto' }}>
            <div style={{ marginBottom: '12px' }}>
              <label style={formStyles.fieldLabel}>API Key</label>
              <input
                type="password"
                className="vscode-input"
                style={{ width: '100%' }}
                value={form.apiKey}
                onChange={(e) => updateForm('apiKey', e.target.value)}
                placeholder={selected.hasApiKey ? '(stored — enter to change)' : 'sk-...'}
              />
            </div>

            <div style={{ marginBottom: '12px' }}>
              <label style={formStyles.fieldLabel}>Endpoint URL</label>
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

            <div style={{ marginBottom: '12px' }}>
              <label style={{ ...formStyles.fieldLabel, marginBottom: '6px' }}>
                Pricing Overrides (USD per 1M tokens)
              </label>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 120px' }}>
                  <label style={formStyles.subLabel}>Prompt ($/1M)</label>
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
                  <label style={formStyles.subLabel}>Completion ($/1M)</label>
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
                  <label style={formStyles.subLabel}>Cache Read ($/1M)</label>
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
        {/* Primary Providers header with + New button (same style as CompositeList) */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
        }}>
          <span style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', color: 'var(--vscode-descriptionForeground, #999)' }}>
            Primary Providers
          </span>
          <button
            className="vscode-button"
            style={{ padding: '2px 8px', fontSize: '12px' }}
            onClick={() => { setSelectedId(null); setShowAddCustom(true); setEditingCustomId(null); }}
          >
            + New
          </button>
        </div>

        {/* Built-in providers */}
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
        }}>
          Custom Providers
        </div>

        {customProviders.length === 0 ? (
          <div style={{ padding: '12px', fontSize: '11px', color: 'var(--vscode-descriptionForeground, #999)', textAlign: 'center' }}>
            No custom providers registered. Click "+ New" to register one.
          </div>
        ) : (
          customProviders.map((cp) => {
            const isSelected = cp.id === selectedId;
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

// ─── Shared styles ────────────────────────────────────────────────

const formStyles: Record<string, React.CSSProperties> = {
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
