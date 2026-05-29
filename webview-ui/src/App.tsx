import React from 'react';
import ErrorBoundary from './components/ErrorBoundary';
import ConfigEditor from './components/ConfigEditor';
import MetricsPanel from './components/MetricsPanel';
import type { CompositeModelConfig, ModelRegistrySummary, HostMessage, MetricsPayload } from './types';
import { onMessage, postMessage } from './utils/vscode';

type Tab = 'config' | 'metrics';

/**
 * Root application component with tab navigation.
 *
 * Two tabs:
 *   - Config: composite model editor (existing)
 *   - Metrics: live metrics dashboard (new)
 */
export default function App() {
  const [initialized, setInitialized] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<Tab>('config');
  const [compositeModels, setCompositeModels] = React.useState<CompositeModelConfig[]>([]);
  const [modelRegistry, setModelRegistry] = React.useState<ModelRegistrySummary[]>([]);
  const [metrics, setMetrics] = React.useState<MetricsPayload | null>(null);

  React.useEffect(() => {
    // Signal that the webview is ready to receive data
    postMessage({ type: 'webviewReady' });

    const unsub = onMessage((msg: HostMessage) => {
      if (msg.type === 'initConfig') {
        setCompositeModels(msg.compositeModels);
        setModelRegistry(msg.modelRegistry);
        setInitialized(true);
      } else if (msg.type === 'metricsUpdate') {
        setMetrics(msg.metrics);
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
        </div>

        <div style={styles.content}>
          {activeTab === 'config' ? (
            <ConfigEditor initialModels={compositeModels} modelRegistry={modelRegistry} />
          ) : (
            <MetricsPanel metrics={metrics} />
          )}
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
