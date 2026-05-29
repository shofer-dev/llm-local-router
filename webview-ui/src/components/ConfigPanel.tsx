import React from 'react';
import ConfigEditor from './ConfigEditor';
import ProvidersPanel from './ProvidersPanel';
import type { CompositeModelConfig, ModelRegistrySummary, ProviderConfigEntry } from '../types';
import { onMessage } from '../utils/vscode';

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
  const [subTab, setSubTab] = React.useState<ConfigSubTab>('composite');

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
          style={subTab === 'composite' ? styles.subTabActive : styles.subTab}
          onClick={() => setSubTab('composite')}
        >
          Composite Models
        </button>
        <button
          style={subTab === 'providers' ? styles.subTabActive : styles.subTab}
          onClick={() => setSubTab('providers')}
        >
          Primary Providers
        </button>
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
