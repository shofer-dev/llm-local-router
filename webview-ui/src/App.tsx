import React from 'react';
import ErrorBoundary from './components/ErrorBoundary';
import ConfigPanel from './components/ConfigPanel';
import MetricsPanel from './components/MetricsPanel';
import StatusPanel from './components/StatusPanel';
import HelpPanel from './components/HelpPanel';
import AboutPanel from './components/AboutPanel';
import type { CompositeModelConfig, ModelRegistrySummary, HostMessage, MetricsPayload, StatusPayload, ProviderConfigEntry } from './types';
import { onMessage, postMessage } from './utils/vscode';

type Tab = 'status' | 'config' | 'metrics' | 'help' | 'about';

/**
 * Root application component with tab navigation.
 *
 * Three tabs:
 *   - Status: provider health, available models, connection info
 *   - Config: composite model editor
 *   - Metrics: live metrics dashboard
 *
 * The host can specify an activeTab in the initConfig message to
 * set the initial tab when opening the webview.
 */
export default function App() {
  const [initialized, setInitialized] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<Tab>('status');
  const [compositeModels, setCompositeModels] = React.useState<CompositeModelConfig[]>([]);
  const [modelRegistry, setModelRegistry] = React.useState<ModelRegistrySummary[]>([]);
  const [metrics, setMetrics] = React.useState<MetricsPayload | null>(null);
  const [status, setStatus] = React.useState<StatusPayload | null>(null);
  const [providers, setProviders] = React.useState<ProviderConfigEntry[]>([]);
  const [version, setVersion] = React.useState<string>('');

  React.useEffect(() => {
    // Signal that the webview is ready to receive data
    postMessage({ type: 'webviewReady' });

    const unsub = onMessage((msg: HostMessage) => {
      if (msg.type === 'initConfig') {
        setCompositeModels(msg.compositeModels);
        setModelRegistry(msg.modelRegistry);
        setVersion(msg.version);
        if (msg.activeTab && msg.activeTab !== 'providers') {
          setActiveTab(msg.activeTab);
        }
        setInitialized(true);
      } else if (msg.type === 'metricsUpdate') {
        setMetrics(msg.metrics);
      } else if (msg.type === 'statusUpdate') {
        setStatus(msg.status);
      } else if (msg.type === 'initProviderConfig') {
        setProviders(msg.providers);
      }
    });

    return unsub;
  }, []);

  if (!initialized) {
    return (
      <div style={styles.loading}>
        Loading configuration...
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div style={styles.root}>
        <div style={styles.tabBar}>
          <button
            style={activeTab === 'status' ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab('status')}
          >
            🔌 Status
          </button>
          <button
            style={activeTab === 'config' ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab('config')}
          >
            ⚙️ Config
          </button>
          <button
            style={activeTab === 'metrics' ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab('metrics')}
          >
            📊 Metrics
          </button>
          <button
            style={activeTab === 'help' ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab('help')}
          >
            🧭 Help
          </button>
          <button
            style={activeTab === 'about' ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab('about')}
          >
            ℹ️ About
          </button>
        </div>

        <div style={styles.content}>
          {activeTab === 'status' && <StatusPanel status={status} />}
          {activeTab === 'config' && (
            <ConfigPanel
              initialModels={compositeModels}
              modelRegistry={modelRegistry}
              providers={providers}
            />
          )}
          {activeTab === 'metrics' && <MetricsPanel metrics={metrics} />}
          {activeTab === 'help' && <HelpPanel />}
          {activeTab === 'about' && <AboutPanel version={version} />}
        </div>
      </div>
    </ErrorBoundary>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
  },
  tabBar: {
    display: 'flex',
    borderBottom: '1px solid var(--vscode-panel-border)',
    padding: '0 8px',
    gap: '2px',
    backgroundColor: 'var(--vscode-editor-background)',
    flexShrink: 0,
  },
  tab: {
    padding: '6px 14px',
    cursor: 'pointer',
    border: 'none',
    background: 'none',
    color: 'var(--vscode-descriptionForeground)',
    fontSize: '12px',
    borderBottom: '2px solid transparent',
    fontFamily: 'var(--vscode-font-family)',
  },
  tabActive: {
    padding: '6px 14px',
    cursor: 'pointer',
    border: 'none',
    background: 'none',
    color: 'var(--vscode-foreground)',
    fontSize: '12px',
    fontWeight: 600,
    borderBottom: '2px solid var(--vscode-focusBorder, #007acc)',
    fontFamily: 'var(--vscode-font-family)',
  },
  content: {
    flex: 1,
    overflow: 'auto',
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    color: 'var(--vscode-descriptionForeground, #999)',
    fontSize: '13px',
  },
};
