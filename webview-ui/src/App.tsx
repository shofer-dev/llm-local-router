import React from 'react';
import ErrorBoundary from './components/ErrorBoundary';
import ConfigEditor from './components/ConfigEditor';
import type { CompositeModelConfig, ModelRegistrySummary, HostMessage } from './types';
import { onMessage, postMessage } from './utils/vscode';

/**
 * Root application component.
 *
 * Listens for the `initConfig` message from the extension host,
 * then renders the ConfigEditor with the received data.
 */
export default function App() {
  const [initialized, setInitialized] = React.useState(false);
  const [compositeModels, setCompositeModels] = React.useState<CompositeModelConfig[]>([]);
  const [modelRegistry, setModelRegistry] = React.useState<ModelRegistrySummary[]>([]);

  React.useEffect(() => {
    // Signal that the webview is ready to receive data
    postMessage({ type: 'webviewReady' });

    const unsub = onMessage((msg: HostMessage) => {
      if (msg.type === 'initConfig') {
        setCompositeModels(msg.compositeModels);
        setModelRegistry(msg.modelRegistry);
        setInitialized(true);
      }
    });

    return unsub;
  }, []);

  if (!initialized) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          color: 'var(--vscode-descriptionForeground, #999)',
          fontSize: '13px',
        }}
      >
        Loading configuration...
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <ConfigEditor initialModels={compositeModels} modelRegistry={modelRegistry} />
    </ErrorBoundary>
  );
}
