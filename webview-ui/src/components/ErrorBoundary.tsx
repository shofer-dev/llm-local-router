import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

/**
 * Catches rendering errors in the component tree and displays
 * a VS Code-themed error fallback instead of a blank webview.
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface render crashes in the webview devtools console so field issues
    // are debuggable instead of silently swallowed into the fallback UI.
    console.error('[llm-local-router webview] render error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '20px', color: 'var(--vscode-errorForeground, #f48771)' }}>
          <h2 style={{ marginBottom: '8px' }}>Something went wrong</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '12px' }}>
            {this.state.error?.message ?? 'Unknown error'}
          </pre>
          <button
            className="vscode-button"
            style={{ marginTop: '12px' }}
            onClick={() => this.setState({ hasError: false, error: undefined })}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
