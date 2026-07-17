import React from 'react';
import ConfigEditor from './ConfigEditor';
import ProvidersPanel from './ProvidersPanel';
import type { CompositeModelConfig, ModelRegistrySummary, ProviderConfigEntry } from '../types';
import { onMessage, postMessage } from '../utils/vscode';

interface Props {
  initialModels: CompositeModelConfig[];
  modelRegistry: ModelRegistrySummary[];
  providers: ProviderConfigEntry[];
}

type ConfigSubTab = 'composite' | 'providers';

/**
 * Config panel with sub-tabs: Composite Models and Primary Providers.
 * Both are configuration, so they share the same top-level tab.
 */
export default function ConfigPanel({ initialModels, modelRegistry, providers }: Props) {
  const [subTab, setSubTab] = React.useState<ConfigSubTab>('providers');

  // Filter model registry to only show models from providers with API keys configured.
  // If no providers are configured at all, show all models (so user can build composites
  // before configuring keys).
  const configuredProviderIds = new Set(
    providers.filter((p) => p.hasApiKey).map((p) => p.id),
  );
  const hasAnyConfigured = configuredProviderIds.size > 0;
  const filteredRegistry = hasAnyConfigured
    ? modelRegistry.filter((m) => configuredProviderIds.has(m.provider))
    : modelRegistry;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Sub-tab bar */}
      <div style={styles.subTabBar}>
        <button
          style={subTab === 'providers' ? styles.subTabActive : styles.subTab}
          onClick={() => setSubTab('providers')}
        >
          Primary Providers
        </button>
        <button
          style={subTab === 'composite' ? styles.subTabActive : styles.subTab}
          onClick={() => setSubTab('composite')}
        >
          Composite Models
        </button>

        {/* Whole-router config I/O — applies to both sub-tabs, so it lives here
            rather than inside either one. The host owns the file dialogs. */}
        <div style={styles.configIo}>
          <button
            style={styles.ioButton}
            onClick={() => postMessage({ type: 'importRouterConfig' })}
            title="Import provider API keys, endpoints and settings from a JSON file"
          >
            Import Config
          </button>
          <button
            style={styles.ioButton}
            onClick={() => postMessage({ type: 'exportRouterConfig' })}
            title="Export the current config to a JSON file (API key values are not included)"
          >
            Export Config
          </button>
        </div>
      </div>

      {/* Sub-tab content */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {subTab === 'composite' && (
          <ConfigEditor initialModels={initialModels} modelRegistry={filteredRegistry} />
        )}
        {subTab === 'providers' && (
          <ProvidersPanel providers={providers} />
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  subTabBar: {
    display: 'flex',
    borderBottom: '1px solid var(--vscode-panel-border)',
    padding: '0 8px',
    gap: '0',
    backgroundColor: 'var(--vscode-editor-background)',
    flexShrink: 0,
  },
  configIo: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  ioButton: {
    padding: '2px 8px',
    cursor: 'pointer',
    border: '1px solid var(--vscode-button-secondaryBackground, var(--vscode-panel-border))',
    borderRadius: '2px',
    background: 'var(--vscode-button-secondaryBackground, transparent)',
    color: 'var(--vscode-button-secondaryForeground, var(--vscode-descriptionForeground))',
    fontSize: '11px',
    fontFamily: 'var(--vscode-font-family)',
  },
  subTab: {
    padding: '4px 12px',
    cursor: 'pointer',
    border: 'none',
    background: 'none',
    color: 'var(--vscode-descriptionForeground)',
    fontSize: '11px',
    borderBottom: '2px solid transparent',
    fontFamily: 'var(--vscode-font-family)',
  },
  subTabActive: {
    padding: '4px 12px',
    cursor: 'pointer',
    border: 'none',
    background: 'none',
    color: 'var(--vscode-foreground)',
    fontSize: '11px',
    fontWeight: 600,
    borderBottom: '2px solid var(--vscode-focusBorder, #007acc)',
    fontFamily: 'var(--vscode-font-family)',
  },
};
